// **FullWriter** extends the N3.js Writer with N3 formulas.
// N3.js writes statements as they arrive, but a formula has to be written in full
// where it is used, so this writer holds back statements with formulas until `end`.
import type * as RDF from '@rdfjs/types';
import { N3Term, N3Writer } from './n3.js';
import type { EndCallback, Prefixes, WriteCallback, WriterOptions, WriterOutputStream } from './n3-internals.js';

// The quads of each formula, keyed by the label of the blank node that stands for it
export type Formulas = Record<string, RDF.Quad[]>;

export interface FullWriterOptions extends WriterOptions {
  // The formulas to write in place of their blank nodes, which requires the N3 format
  formulas?: Formulas;
}

interface Statement {
  subject: RDF.Term;
  predicate: RDF.Term;
  object: RDF.Term;
}

interface Frame {
  label: string;
  position: number;
  nested?: string[];
}

// The scope of blank nodes, which is a formula or the top level
type Scope = object;

const { hasOwnProperty } = Object.prototype;

const HELPERS_WITH_FORMULAS = 'Cannot use nodes created by blank() or list() once formulas are in use';
const GRAPHS_WITH_FORMULAS = 'Cannot write named graphs once formulas are in use';
const LISTS_WITH_FORMULAS = 'Cannot write formulas with the lists option; write lists as rdf:first and rdf:rest statements instead';
// The scope of blank nodes outside formulas
const TOP_SCOPE: Scope = {};

const QUOTED_TRIPLES_TOO_DEEP = 'Cannot write quoted triples nested more than 256 levels deep once formulas are in use';
// The deepest nesting of quoted triples inside one term, as N3.js serializes these recursively
export const MAX_QUOTED_TRIPLE_DEPTH = 256;
// The term types of RDF/JS terms; nodes from `blank` and `list` have none
const TERM_TYPES = new Set(['NamedNode', 'BlankNode', 'Literal', 'Variable', 'DefaultGraph', 'Quad']);

// Checks that the terms are RDF/JS terms, which rejects nodes from `blank` and `list`,
// and that their quoted triples are in the default graph and not nested too deeply
function checkTerms(terms: RDF.Term[]) {
  const pending: [RDF.Term, number][] = terms.map(term => [term, 0]);
  while (pending.length) {
    const [term, depth] = pending.pop()!;
    if (!term || !TERM_TYPES.has(term.termType))
      throw new Error(HELPERS_WITH_FORMULAS);
    if (term.termType === 'Quad') {
      if (depth >= MAX_QUOTED_TRIPLE_DEPTH)
        throw new Error(QUOTED_TRIPLES_TOO_DEEP);
      if (!term.graph || term.graph.termType !== 'DefaultGraph')
        throw new Error(TERM_TYPES.has(term.graph && term.graph.termType) ? GRAPHS_WITH_FORMULAS : HELPERS_WITH_FORMULAS);
      pending.push([term.subject, depth + 1], [term.predicate, depth + 1], [term.object, depth + 1]);
    }
  }
}

// Builds a key that tells terms apart by type and value, also inside quoted triples,
// which `termToId` does not (an IRI `?x` and a variable `x` share an id).
// Quoted triples were checked to be nested at most `MAX_QUOTED_TRIPLE_DEPTH` levels deep.
function termKey(term: RDF.Term): string {
  switch (term.termType) {
  case 'Quad':
    return `[${termKey(term.subject)},${termKey(term.predicate)},${termKey(term.object)}]`;
  case 'Literal':
    return JSON.stringify([term.termType, term.value, term.language,
      (term as RDF.Literal & { direction?: string }).direction || '', term.datatype.value]);
  default:
    return JSON.stringify([term.termType, term.value]);
  }
}
// Joins strings by concatenation, which unlike `Array#join` does not copy the strings,
// so that nested formulas are not copied at every level
function concat(strings: string[], separator: string) {
  let result = strings[0];
  for (let i = 1; i < strings.length; i++)
    result += separator + strings[i];
  return result;
}

// ## Constructor
export default class FullWriter extends N3Writer {
  // These are declared without being defined, so that they keep the values that
  // `addPrefixes` sets while the N3.js constructor runs
  declare private _formulas?: Formulas;
  declare private _openFormulas: Set<string>;
  declare private _formulaCache: Map<string, InstanceType<typeof N3Term>> | null;
  // Statements with formulas are held back until the end, to group them by formula
  declare private _formulaStatements: Statement[] | null;
  // `_prefixNames` maps each prefix to the IRI it is bound to
  declare private _prefixNames?: Record<string, string>;
  // N3 scopes blank node labels to their formula, so each blank node is written in one scope only.
  // `_blankScopes` maps the labels of blank nodes to their scope when formulas are in use.
  declare private _blankScopes: Map<string, Scope> | null;
  // Formulas are serialized only while the held-back statements are written, each of them once
  declare private _encodingFormulas: boolean;
  declare private _writtenFormulas: Set<string>;
  declare private _endError?: Error;

  constructor(options?: FullWriterOptions);
  constructor(outputStream: WriterOutputStream | null | undefined, options?: FullWriterOptions);
  constructor(outputStream?: WriterOutputStream | FullWriterOptions | null, options?: FullWriterOptions) {
    // Shift arguments if the first argument is not a stream
    if (outputStream && typeof (outputStream as WriterOutputStream).write !== 'function') {
      options = outputStream as FullWriterOptions;
      outputStream = null;
    }
    options = options || {};
    // Check the options before the N3.js constructor writes anything
    const formulas = options.formulas;
    if (formulas) {
      if (!(/n3/i).test(options.format || ''))
        throw new Error('Cannot write formulas in formats other than N3');
      if (options.lists)
        throw new Error(LISTS_WITH_FORMULAS);
    }
    super(outputStream as WriterOutputStream | null, options);
    this._formulas = formulas;
    this._openFormulas = new Set();
    this._formulaCache = null;
    this._formulaStatements = formulas ? [] : null;
    this._blankScopes = formulas ? new Map() : null;
    this._encodingFormulas = false;
    this._writtenFormulas = new Set();
  }

  // ### `_writeQuad` writes the quad to the output stream
  protected _writeQuad(subject: RDF.Term, predicate: RDF.Term, object: RDF.Term, graph: RDF.Term,
    done?: WriteCallback) {
    // Once formulas are in use, check the statement against them, and hold it back if needed
    if (this._blankScopes && this._holdQuad(subject, predicate, object, graph, done))
      return;
    super._writeQuad(subject, predicate, object, graph, done);
  }

  // ### `_isFormula` checks whether the term is a blank node labelling a given formula
  private _isFormula(term: RDF.Term) {
    return !!this._formulas && term.termType === 'BlankNode' && hasOwnProperty.call(this._formulas, term.value);
  }

  // ### `_findFormulas` lists the labels of the formulas in the terms, first term first,
  // including inside quoted triples
  private _findFormulas(terms: RDF.Term[]) {
    const formulas: string[] = [];
    terms = terms.slice();
    while (terms.length) {
      const term = terms.pop()!;
      if (term.termType === 'Quad')
        terms.push(term.graph, term.object, term.predicate, term.subject);
      else if (this._isFormula(term))
        formulas.push(term.value);
    }
    return formulas;
  }

  // ### `_holdQuad` checks a statement once formulas are in use,
  // and holds it back until the end if it contains formulas, so every formula can be written once.
  // Returns whether the statement was handled.
  private _holdQuad(subject: RDF.Term, predicate: RDF.Term, object: RDF.Term, graph: RDF.Term,
    done?: WriteCallback): boolean {
    try {
      // A closed writer accepts nothing
      if (this._write === this._blockedWrite)
        this._blockedWrite();
      this._checkStatement(subject, predicate, object, graph);
    }
    catch (error) {
      if (done)
        return done(error as Error), true;
      throw error;
    }
    if (!this._formulaStatements || !this._findFormulas([object, predicate, subject]).length)
      return false;
    this._formulaStatements.push({ subject, predicate, object });
    if (done)
      done();
    return true;
  }

  // ### `_checkStatement` checks that the statement keeps every blank node in one scope,
  // which nodes from `blank` and `list` would hide, and that every formula is written once,
  // which statements in named graphs would not
  private _checkStatement(subject: RDF.Term, predicate: RDF.Term, object: RDF.Term, graph: RDF.Term) {
    if (graph && graph.termType !== 'DefaultGraph')
      throw new Error(GRAPHS_WITH_FORMULAS);
    checkTerms([subject, predicate, object]);
    this._addBlankScopes(this._findBlankScopes([subject, predicate, object], TOP_SCOPE));
  }

  // ### `_findBlankScopes` lists the blank nodes of the terms that are new to the given scope,
  // rejecting blank nodes that were written in another scope
  private _findBlankScopes(terms: RDF.Term[], scope: Scope, found = new Map<string, Scope>()) {
    terms = terms.slice();
    while (terms.length) {
      const term = terms.pop()!;
      if (term.termType === 'Quad')
        terms.push(term.subject, term.predicate, term.object, term.graph);
      else if (term.termType === 'BlankNode' && !this._isFormula(term)) {
        const previous = this._blankScopes!.get(term.value);
        if (previous === undefined)
          found.set(term.value, scope);
        else if (previous !== scope)
          throw new Error(`Cannot write blank node _:${term.value} both inside and outside a formula`);
      }
    }
    return found;
  }

  // ### `_addBlankScopes` records the scopes of blank nodes, once they have been checked
  private _addBlankScopes(scopes: Map<string, Scope>) {
    for (const [label, scope] of scopes)
      this._blankScopes!.set(label, scope);
  }

  // ### `_encodeFormula` serializes the formula with the given label.
  // Nested formulas are serialized first, depth-first with an explicit stack,
  // so deeply nested formulas do not exhaust the call stack.
  private _encodeFormula(label: string) {
    // Every formula inside it is found and serialized here, so this is never called recursively
    const frames: Frame[] = [{ label, position: 0 }], cache = this._formulaCache = new Map();
    this._openFormulas.add(label);
    try {
      while (frames.length) {
        const frame = frames[frames.length - 1], quads = this._formulas![frame.label];
        // Find the next nested formula that is not serialized yet
        if (!frame.nested) {
          // Check the terms first, as finding formulas in them assumes they are well-formed
          this._checkFormulaQuads(quads);
          const terms = [];
          for (let i = quads.length - 1; i >= 0; i--)
            terms.push(quads[i].object, quads[i].predicate, quads[i].subject);
          frame.nested = this._findFormulas(terms);
        }
        let nested = null;
        while (!nested && frame.position < frame.nested.length) {
          const candidate = frame.nested[frame.position++];
          // A formula inside itself would never end
          if (this._openFormulas.has(candidate))
            throw new Error(`Cannot write formula _:${candidate} inside itself`);
          if (!cache.has(candidate))
            nested = candidate;
        }
        if (nested) {
          this._openFormulas.add(nested);
          frames.push({ label: nested, position: 0 });
        }
        else {
          cache.set(frame.label, this._encodeFormulaQuads(quads));
          this._openFormulas.delete(frame.label);
          frames.pop();
        }
      }
      const formula = cache.get(label)!;
      cache.delete(label);
      return formula;
    }
    finally {
      this._formulaCache = null;
      this._openFormulas.clear();
    }
  }

  // ### `_encodeFormulaLabel` serializes the formula with the given label where it is written
  private _encodeFormulaLabel(label: string) {
    // Formulas are written at the end, where the writer can write each of them once
    if (!this._encodingFormulas)
      throw new Error('Cannot serialize formulas outside of statements');
    // A copy would be read back as another formula
    if (this._writtenFormulas.has(label))
      throw new Error(`Cannot write formula _:${label} more than once`);
    this._writtenFormulas.add(label);
    // Serialized formulas are used once, so that deep nesting keeps no copies
    const cached = this._formulaCache && this._formulaCache.get(label);
    if (cached)
      this._formulaCache!.delete(label);
    return cached || this._encodeFormula(label);
  }

  // ### `_encodeIriOrBlank` represents an IRI or blank node,
  // and writes the contents of a formula in place of its blank node
  protected _encodeIriOrBlank(entity: RDF.Term) {
    if (this._formulas && this._isFormula(entity))
      entity = this._encodeFormulaLabel(entity.value) as unknown as RDF.Term;
    return super._encodeIriOrBlank(entity);
  }

  // ### `addPrefixes` adds the prefixes to the output stream
  addPrefixes(prefixes: Prefixes, done?: WriteCallback) {
    // The N3.js constructor adds the `prefixes` option before this constructor runs
    const prefixNames = this._prefixNames || (this._prefixNames = Object.create(null) as Record<string, string>);
    const bindings: [string, string][] = [];
    for (const prefix in prefixes) {
      const iri = prefixes[prefix];
      bindings.push([`${prefix}:`, typeof iri === 'string' ? iri : iri.value]);
    }
    // N3.js keeps writing IRIs with a prefix after it was rebound,
    // and formulas are written at the end, so prefixes cannot be rebound once formulas are in use
    if (this._formulas) {
      for (const [prefix, iri] of bindings) {
        if (prefix in prefixNames && prefixNames[prefix] !== iri)
          throw new Error(`Cannot rebind prefix ${prefix} once formulas are in use`);
      }
    }
    super.addPrefixes(prefixes, done);
    for (const [prefix, iri] of bindings)
      prefixNames[prefix] = iri;
  }

  // ### `blank` creates a blank node with the given content
  blank(...args: Parameters<InstanceType<typeof N3Writer>['blank']>) {
    // Pretty-printed nodes hide their blank nodes and formulas from the checks of formulas
    if (this._blankScopes)
      throw new Error(HELPERS_WITH_FORMULAS);
    return super.blank(...args);
  }

  // ### `list` creates a list node with the given content
  list(elements?: RDF.Term[]) {
    // Pretty-printed nodes hide their blank nodes and formulas from the checks of formulas
    if (this._blankScopes)
      throw new Error(HELPERS_WITH_FORMULAS);
    return super.list(elements);
  }

  // ### `_checkFormulaQuads` checks the quads of a formula like statements
  private _checkFormulaQuads(quads: RDF.Quad[]) {
    for (const { subject, predicate, object, graph } of quads) {
      // Quads of formulas are in the default graph, or in the graph the parser labels the formula with
      if (graph && graph.termType !== 'DefaultGraph' && graph.termType !== 'BlankNode')
        throw new Error(GRAPHS_WITH_FORMULAS);
      checkTerms([subject, predicate, object]);
    }
  }

  // ### `_encodeFormulaQuads` serializes the quads of a formula, with its formulas already serialized
  private _encodeFormulaQuads(quads: RDF.Quad[]) {
    const statements = this._encodeStatements(quads);
    // Check the blank nodes after nested formulas were written, as these record theirs
    const scope: Scope = {}, scopes = new Map<string, Scope>();
    for (const quad of quads)
      this._findBlankScopes([quad.subject, quad.predicate, quad.object], scope, scopes);
    this._addBlankScopes(scopes);
    // N3.js writes its own terms as their id
    return new N3Term(statements.length ? `{ ${concat(statements, '. ')} }` : '{}');
  }

  // ### `_encodeStatements` serializes N3 statements, so that every formula is written once.
  // A formula that occurs more than once becomes the subject of its statements,
  // using inverse `is … of` verbs where it is their object,
  // or the verb shared by a list of objects (or of subjects, with an inverse verb).
  private _encodeStatements(quads: Statement[]) {
    // Count the occurrences of terms that contain formulas, such as quoted triples
    const occurrences = new Map<string, boolean>(), verbSubjects = new Map<string, string | false>();
    const statements = new Map<string, { head: RDF.Term, verbs: [VerbMap, VerbMap] }>();
    type VerbMap = Map<string, { predicate: RDF.Term, terms: RDF.Term[] }>;
    for (const quad of quads) {
      for (const term of [quad.subject, quad.predicate, quad.object]) {
        if (this._findFormulas([term]).length) {
          const key = termKey(term);
          occurrences.set(key, occurrences.has(key));
        }
      }
    }
    function isShared(term: RDF.Term) { return occurrences.get(termKey(term)) === true; }
    for (const { subject, predicate } of quads) {
      if (isShared(predicate)) {
        const key = termKey(predicate), subjects = verbSubjects.get(key);
        verbSubjects.set(key, subjects === undefined ? termKey(subject) : subjects === termKey(subject) && subjects);
      }
    }
    for (const { subject, predicate, object } of quads) {
      const inverse = !isShared(subject) && (isShared(object) ||
                      isShared(predicate) && verbSubjects.get(termKey(predicate)) === false);
      const head = inverse ? object : subject, headKey = termKey(head);
      let statement = statements.get(headKey);
      if (!statement)
        statements.set(headKey, statement = { head, verbs: [new Map(), new Map()] });
      const verbs = statement.verbs[inverse ? 1 : 0], verbKey = termKey(predicate);
      let verb = verbs.get(verbKey);
      if (!verb)
        verbs.set(verbKey, verb = { predicate, terms: [] });
      verb.terms.push(inverse ? subject : object);
    }
    const result: string[] = [];
    for (const { head, verbs } of statements.values()) {
      const parts: string[] = [];
      for (const { predicate, terms } of verbs[0].values())
        parts.push(`${this._encodePredicate(predicate)} ${concat(terms.map(term => this._encodeObject(term)), ', ')}`);
      for (const { predicate, terms } of verbs[1].values()) {
        const verb = this._encodePredicate(predicate);
        parts.push(`is ${verb === 'a' ? this._encodeIriOrBlank(predicate) : verb} of ${
          concat(terms.map(term => this._encodeSubject(term)), ', ')}`);
      }
      result.push(`${this._encodeSubject(head)} ${concat(parts, '; ')}`);
    }
    return result;
  }

  // ### `end` writes the statements with formulas and signals the end of the output stream,
  // like `N3.Writer`. Formulas that cannot be written are reported before anything is written,
  // to `done`, or thrown without it, and the writer is closed.
  end(done?: EndCallback) {
    // Report the error of an earlier end
    if (this._endError) {
      if (done)
        return done(this._endError);
      throw this._endError;
    }
    // Write the statements with formulas, which were held back
    const formulaStatements = this._formulaStatements;
    // Stop holding back statements, also when encoding them creates formulas
    this._formulaStatements = null;
    if (formulaStatements && formulaStatements.length) {
      let output;
      this._encodingFormulas = true;
      try {
        output = `${concat(this._encodeStatements(formulaStatements), '.\n')}.\n`;
      }
      catch (error) {
        // Close the writer, and report the same error on later ends.
        // Errors of the output stream while closing it would hide this error, so they are ignored.
        this._endError = error as Error;
        try { this._endStatement(); }
        catch { /* the error of the formulas is reported */ }
        this._subject = null;
        this._write = this._blockedWrite;
        // With no statement pending, `N3.Writer#end` only ends the output stream, ignoring its errors
        super.end();
        if (done)
          return done(error as Error);
        throw error;
      }
      finally { this._encodingFormulas = false; }
      // Finish a possible pending quad before the statements with formulas
      this._endStatement();
      this._write(output);
    }
    super.end(done);
  }
}
