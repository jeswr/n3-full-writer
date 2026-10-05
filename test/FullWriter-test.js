import { jest } from '@jest/globals';
import { BlankNode, DefaultGraph, Literal, NamedNode, Parser, Quad, Store, Variable, Writer } from 'n3';
import { isomorphic } from 'rdf-isomorphic';
import FullWriter from '../src/index.js';

function end(writer) {
  return new Promise((resolve, reject) => {
    writer.end((error, output) => error ? reject(error) : resolve(output));
  });
}

describe('A FullWriter writing N3 formulas', () => {
  // Groups parsed N3 quads into top-level statements and formula contents
  function splitFormulas(quads) {
    const formulas = {}, statements = [];
    for (const quad of quads) {
      if (quad.graph.termType === 'BlankNode')
        (formulas[quad.graph.value] || (formulas[quad.graph.value] = [])).push(quad);
      else
        statements.push(quad);
    }
    return { formulas, statements };
  }

  // Shuffles quads deterministically for the given seed
  function shuffle(quads, seed) {
    const shuffled = quads.slice();
    for (let i = shuffled.length - 1; i > 0; i--) {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      const j = seed % (i + 1);
      [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }
    return shuffled;
  }

  // Writes the parsed document, with its quads shuffled for a non-zero seed,
  // and rebuilt by a store if `via` is 'store'
  async function roundTrip(document, seed, via) {
    // Duplicate statements are only counted once
    const quads = new Store(new Parser({ format: 'N3' }).parse(document)).getQuads();
    const input = via === 'store' ? new Store(quads).getQuads() : quads;
    const { formulas, statements } = splitFormulas(seed ? shuffle(input, seed) : input);
    const writer = new FullWriter({ format: 'N3', formulas });
    writer.addQuads(statements);
    const output = await end(writer);
    return { quads, output, reparsed: new Parser({ format: 'N3' }).parse(output) };
  }

  it('should write the formulas of a rule', async () => {
    const { quads, output, reparsed } = await roundTrip('{ ?s a ?o } => { ?s a ?o }.');
    expect(output).toBe('{ ?s a ?o } <http://www.w3.org/2000/10/swap/log#implies> { ?s a ?o }.\n');
    expect(isomorphic(reparsed, quads)).toBe(true);
  });

  it('should write nested formulas and formulas with several statements', async () => {
    const document = '@prefix : <http://ex.org/>. :a :says { :b :c :d. :e :f { :g :h "i"@en } }.';
    const { quads, output, reparsed } = await roundTrip(document);
    expect(output).toBe('<http://ex.org/a> <http://ex.org/says> { <http://ex.org/b> <http://ex.org/c> <http://ex.org/d>. ' +
      '<http://ex.org/e> <http://ex.org/f> { <http://ex.org/g> <http://ex.org/h> "i"@en } }.\n');
    expect(isomorphic(reparsed, quads)).toBe(true);
  });

  it('should keep a blank node shared by two statements in one formula', async () => {
    const document = '@prefix : <http://ex.org/>. :a :says { _:x :p :o. _:x :q :r }.';
    const { quads, output, reparsed } = await roundTrip(document);
    expect(output).toMatch(/^<http:\/\/ex.org\/a> <http:\/\/ex.org\/says> \{ _:[^ ]+ <http:\/\/ex.org\/p> <http:\/\/ex.org\/o>; <http:\/\/ex.org\/q> <http:\/\/ex.org\/r> \}.\n$/);
    expect(isomorphic(reparsed, quads)).toBe(true);
    // A copy whose blank nodes are distinct is not isomorphic
    const [first, second] = reparsed.filter(quad => quad.subject.termType === 'BlankNode');
    const split = reparsed.map(quad => quad === second ?
      new Quad(new BlankNode('other'), quad.predicate, quad.object, quad.graph) : quad);
    expect(first).toBeDefined();
    expect(isomorphic(split, quads)).toBe(false);
  });

  it('should write formulas whose quads arrive in any order', async () => {
    const documents = [
      '@prefix : <http://ex.org/>. { ?x :p ?y. ?y :q ?z. { ?z :r ?x } => { ?x :s ?z } } => ' +
        '{ ?x :t ?z. ?z :u { ?x :v "w"@en } }.',
      '@prefix : <http://ex.org/>. :a :says { _:x :p :o. _:x :q { _:y :r _:x } }. ' +
        '{ :c :d :e } :f { :g :h :i }. :j :k ({ :l :m :n } { :o :p :q }).',
    ];
    for (const document of documents) {
      for (let seed = 1; seed <= 10; seed++) {
        const { quads, reparsed } = await roundTrip(document, seed);
        expect(isomorphic(reparsed, quads)).toBe(true);
      }
    }
  });

  it('should write a document with many formulas in any order', async () => {
    let document = '@prefix : <http://ex.org/>.\n';
    for (let i = 0; i < 200; i++) {
      document += `{ ?x :p${i % 7} ?y. ?y :q :o${i} } => { ?x :r${i} ?y. :n${i} :says { ?y :s { :d${i} :e _:b${i} } } }.\n`;
      document += `:s${i} :t { :a :b ${i}. :c :d { :e :f "x${i}" } }.\n`;
    }
    for (let seed = 1; seed <= 3; seed++) {
      const { quads, output, reparsed } = await roundTrip(document, seed);
      expect(output.match(/\{/g)).toHaveLength(1200);
      expect(isomorphic(reparsed, quads)).toBe(true);
    }
  });

  it('should write a formula that is the subject of several statements once', async () => {
    const documents = [
      '<urn:s> <urn:p> { { <urn:a> <urn:b> <urn:c> } <urn:p> <urn:d>; <urn:q> <urn:e> }.',
      '{ <urn:a> <urn:b> <urn:c> } <urn:p> <urn:d>; <urn:q> <urn:e>. <urn:x> <urn:y> <urn:z>.',
    ];
    for (const document of documents) {
      for (let seed = 0; seed <= 10; seed++) {
        const { quads, output, reparsed } = await roundTrip(document, seed);
        expect(output.match(/<urn:a>/g)).toHaveLength(1);
        expect(reparsed).toHaveLength(quads.length);
        expect(isomorphic(reparsed, quads)).toBe(true);
      }
    }
  });

  it('should write a formula that is the object of several statements once', async () => {
    const documents = [
      '{ <urn:a> <urn:b> <urn:c> } is <urn:p> of <urn:s>, <urn:t>.',
      '{ <urn:a> <urn:b> <urn:c> } is a of <urn:s>, <urn:t>; <urn:q> <urn:r>.',
      '<urn:x> <urn:y> { { <urn:a> <urn:b> <urn:c> } is <urn:p> of { <urn:d> <urn:e> <urn:f> }, <urn:t> }.',
    ];
    for (const document of documents) {
      for (let seed = 0; seed <= 10; seed++) {
        const { quads, output, reparsed } = await roundTrip(document, seed);
        expect(output.match(/<urn:a>/g)).toHaveLength(1);
        expect(reparsed).toHaveLength(quads.length);
        expect(isomorphic(reparsed, quads)).toBe(true);
      }
    }
  });

  // Generates a random N3 document with formulas in every position,
  // inside lists, nested, and shared through inverse verbs and object lists
  function randomDocument(random) {
    function pick(n) { return Math.floor(random() * n); }
    function iri() { return `<urn:${'abcdef'[pick(6)]}>`; }
    function formula(depth) { return `{ ${statements(depth)} }`; }
    function repeat(generate, separator) {
      const items = [];
      for (let i = pick(3); i >= 0; i--) items.push(generate());
      return items.join(separator);
    }
    function term(depth, nested = true) {
      const r = random();
      if (depth > 0 && r < 0.3) return formula(depth - 1);
      if (nested && r < 0.37) return `(${term(depth, false)} ${term(depth, false)})`;
      if (nested && r < 0.42) return `<<( ${iri()} ${iri()} ${term(depth, false)} )>>`;
      return r < 0.5 ? `?${'xy'[pick(2)]}` : r < 0.55 ? '"l"' : iri();
    }
    function verb(depth, inverse) {
      const r = random();
      if (depth > 0 && r < 0.15) return formula(depth - 1);
      return !inverse && r < 0.3 ? 'a' : iri();
    }
    function objects(depth) { return repeat(() => random() < 0.2 ? '"l"' : term(depth), ', '); }
    function predicateObjects(depth) {
      return repeat(() => random() < 0.3 ?
        `is ${verb(depth, true)} of ${objects(depth)}` : `${verb(depth)} ${objects(depth)}`, '; ');
    }
    function statements(depth) { return repeat(() => `${term(depth)} ${predicateObjects(depth)}`, '. '); }
    return `${statements(2)}.`;
  }

  it('should write random documents with formulas in any order', async () => {
    for (let seed = 1; seed <= 20; seed++) {
      let state = seed;
      const document = randomDocument(() => (state = (state * 1103515245 + 12345) % 2147483648) / 2147483648);
      for (const [order, via] of [[0], [seed], [seed, 'store']]) {
        const { quads, output, reparsed } = await roundTrip(document, order, via);
        // Every formula is written exactly once
        const formulas = new Set(quads.filter(quad => quad.graph.termType === 'BlankNode').map(quad => quad.graph.value));
        expect((output.match(/\{/g) || []).length).toBe(formulas.size);
        expect(reparsed).toHaveLength(quads.length);
        expect(isomorphic(reparsed, quads)).toBe(true);
      }
    }
  });

  it('should write a formula that is the subject and the object of statements once', async () => {
    const documents = [
      '{ <urn:a> <urn:b> <urn:c> } <urn:p> <urn:o>; is <urn:q> of <urn:s>.',
      '<urn:s> is { <urn:a> <urn:b> <urn:c> } of <urn:o>, <urn:r>.',
      '<urn:s> { <urn:a> <urn:b> <urn:c> } <urn:o>, <urn:r>.',
    ];
    for (const document of documents) {
      for (let seed = 0; seed <= 10; seed++) {
        const { quads, output, reparsed } = await roundTrip(document, seed);
        expect(output.match(/<urn:a>/g)).toHaveLength(1);
        expect(reparsed).toHaveLength(quads.length);
        expect(isomorphic(reparsed, quads)).toBe(true);
      }
    }
  });

  it('should refuse a blank node shared by a formula and its surroundings', async () => {
    const quads = new Parser({ format: 'N3' }).parse('@forSome <urn:x>. <urn:x> <urn:p> { <urn:x> <urn:q> <urn:o> }.');
    const { formulas, statements } = splitFormulas(quads);
    const writer = new FullWriter({ format: 'N3', formulas });
    writer.addQuads(statements);
    await expect(end(writer)).rejects.toThrow(/^Cannot write blank node _:\S+ both inside and outside a formula$/);
  });

  it('should write formulas inside lists written as statements', async () => {
    const { quads, output, reparsed } = await roundTrip('<urn:s> <urn:p> ({ <urn:a> <urn:b> <urn:c> } { <urn:d> <urn:e> ({ <urn:f> <urn:g> <urn:h> }) }).');
    expect((output.match(/\{/g) || []).length).toBe(3);
    expect(isomorphic(reparsed, quads)).toBe(true);
  });

  it('should write formulas inside quoted triples inside formulas', async () => {
    const p = new NamedNode('urn:p');
    const formulas = { f: [new Quad(p, p, new Quad(p, p, new BlankNode('g')))], g: [new Quad(p, p, p)] };
    const writer = new FullWriter({ format: 'N3', formulas });
    writer.addQuad(p, p, new BlankNode('f'));
    expect(await end(writer)).toBe('<urn:p> <urn:p> { <urn:p> <urn:p> <<(<urn:p> <urn:p> { <urn:p> <urn:p> <urn:p> })>> }.\n');
  });

  it('should stream plain statements after a statement with formulas', async () => {
    const p = new NamedNode('urn:p'), chunks = [];
    const outputStream = { write: (chunk, encoding, callback) => { chunks.push(chunk); callback && callback(); },
      end: callback => callback() };
    const writer = new FullWriter(outputStream, { format: 'N3', formulas: { f: [] } });
    writer.addQuad(p, p, new BlankNode('f'));
    for (let i = 0; i < 1000; i++)
      writer.addQuad(new NamedNode(`urn:s${i}`), p, p);
    expect(writer._formulaStatements).toHaveLength(1);
    expect(chunks.join('')).toContain('<urn:s999> <urn:p> <urn:p>');
    await new Promise((resolve, reject) => writer.end(error => error ? reject(error) : resolve()));
    expect(chunks.join('').endsWith('<urn:p> <urn:p> {}.\n')).toBe(true);
  });

  it('should keep an IRI bound to another prefix when rebinding a prefix', async () => {
    const writer = new FullWriter({ format: 'N3', prefixes: { ex: 'urn:old:', other: 'urn:old:' } });
    writer.addPrefix('ex', 'urn:new:');
    writer.addQuad(new NamedNode('urn:old:s'), new NamedNode('urn:new:p'), new NamedNode('urn:new:o'));
    expect(await end(writer)).toBe('@prefix ex: <urn:old:>.\n@prefix other: <urn:old:>.\n\n@prefix ex: <urn:new:>.\n\n' +
      'other:s ex:p ex:o.\n');
  });

  it('should write a formula shared as the predicate of equal literals once', async () => {
    const a = new NamedNode('urn:a'), f = new BlankNode('f');
    const writer = new FullWriter({ format: 'N3', formulas: { f: [new Quad(a, a, a)] } });
    writer.addQuad(new NamedNode('urn:s'), f, new Literal('"x"'));
    writer.addQuad(new NamedNode('urn:t'), f, new Literal('"x"'));
    expect(await end(writer)).toBe('"x" is { <urn:a> <urn:a> <urn:a> } of <urn:s>, <urn:t>.\n');
  });

  it('should write deeply nested formulas inside quoted triples', async () => {
    const depth = 10000, formulas = {}, p = new NamedNode('urn:p');
    for (let i = 0; i < depth; i++)
      formulas[`f${i}`] = [new Quad(p, p, i + 1 < depth ? new Quad(p, p, new BlankNode(`f${i + 1}`)) : p)];
    const writer = new FullWriter({ format: 'N3', formulas });
    writer.addQuad(p, p, new BlankNode('f0'));
    const output = await end(writer);
    expect(output).toBe(`<urn:p> <urn:p> ${'{ <urn:p> <urn:p> <<(<urn:p> <urn:p> '.repeat(depth - 1)}{ <urn:p> <urn:p> <urn:p> }${')>> }'.repeat(depth - 1)}.\n`);
  });

  it('should not accept statements with formulas after the end', async () => {
    const writer = new FullWriter({ format: 'N3', formulas: { f: [] } });
    await end(writer);
    const done = jest.fn();
    writer.addQuad(new BlankNode('f'), new NamedNode('urn:p'), new NamedNode('urn:o'), done);
    expect(done).toHaveBeenCalledWith(new Error('Cannot write because the writer has been closed.'));
  });

  it('should write deeply nested formulas in predicate position', async () => {
    const depth = 20000, formulas = {}, p = new NamedNode('urn:p');
    for (let i = 0; i < depth; i++)
      formulas[`f${i}`] = [new Quad(p, i + 1 < depth ? new BlankNode(`f${i + 1}`) : p, p)];
    const writer = new FullWriter({ format: 'N3', formulas });
    writer.addQuad(p, new BlankNode('f0'), p);
    const output = await end(writer);
    expect(output).toBe(`<urn:p> ${'{ <urn:p> '.repeat(depth)}<urn:p>${' <urn:p> }'.repeat(depth)} <urn:p>.\n`);
  });

  it('should write deeply nested formulas', async () => {
    const depth = 20000, formulas = {}, p = new NamedNode('urn:p');
    for (let i = 0; i < depth; i++)
      formulas[`f${i}`] = [new Quad(p, p, i + 1 < depth ? new BlankNode(`f${i + 1}`) : p)];
    const writer = new FullWriter({ format: 'N3', formulas });
    writer.addQuad(p, p, new BlankNode('f0'));
    const output = await end(writer);
    expect(output).toBe(`<urn:p> <urn:p> ${'{ <urn:p> <urn:p> '.repeat(depth)}<urn:p>${' }'.repeat(depth)}.\n`);
  });

  it('should refuse a formula whose occurrences N3 cannot share', async () => {
    const [a, b, c, p] = ['a', 'b', 'c', 'p'].map(name => new NamedNode(`urn:${name}`)), g = new BlankNode('g');
    for (const formulas of [
      { f: [new Quad(g, p, a), new Quad(b, g, c)], g: [new Quad(a, a, a)] },
      { f: [new Quad(p, p, new Quad(g, p, a)), new Quad(p, p, new Quad(g, p, b))], g: [] },
    ]) {
      const writer = new FullWriter({ format: 'N3', formulas });
      writer.addQuad(a, p, new BlankNode('f'));
      await expect(end(writer)).rejects.toThrow('Cannot write formula _:g more than once');
    }
  });

  it('should refuse a formula inside two other formulas', async () => {
    const p = new NamedNode('urn:p'), [f, g, h] = ['f', 'g', 'h'].map(label => new BlankNode(label));
    const writer = new FullWriter({ format: 'N3', formulas: { f: [new Quad(p, p, g)], g: [], h: [new Quad(p, p, g)] } });
    writer.addQuad(f, p, h);
    await expect(end(writer)).rejects.toThrow('Cannot write formula _:g more than once');
  });

  it('should refuse named graphs on the quads of a formula', async () => {
    const p = new NamedNode('urn:p'), f = new BlankNode('f');
    const writer = new FullWriter({ format: 'N3', formulas: { f: [new Quad(p, p, p, new NamedNode('urn:g'))] } });
    writer.addQuad(p, p, f);
    await expect(end(writer)).rejects.toThrow('Cannot write named graphs once formulas are in use');
    const quads = [new Quad(p, p, p), new Quad(p, p, new NamedNode('urn:o'), f), { subject: p, predicate: p, object: f }];
    const labelled = new FullWriter({ format: 'N3', formulas: { f: [], g: quads } });
    labelled.addQuad(p, p, new BlankNode('g'));
    expect(await end(labelled)).toBe('<urn:p> <urn:p> { <urn:p> <urn:p> <urn:p>, <urn:o>, {} }.\n');
  });

  it('should not serialize formulas or check statements after the end', async () => {
    const [b, p, g] = [new BlankNode('b'), new NamedNode('urn:p'), new NamedNode('urn:g')];
    const writer = new FullWriter({ format: 'N3', formulas: { f: [new Quad(b, p, p)] } });
    expect(await end(writer)).toBe('');
    expect(() => writer.quadToString(p, p, new BlankNode('f'))).toThrow('Cannot serialize formulas outside of statements');
    let error;
    writer.addQuad(b, p, p, g, e => { error = e; });
    expect(error).toEqual(new Error('Cannot write because the writer has been closed.'));
    expect(writer._blankScopes.size).toBe(0);
  });

  it('should write deeply nested formulas with several statements in linear time', async () => {
    const depth = 20000, formulas = {}, [a, p] = [new NamedNode('urn:a'), new NamedNode('urn:p')];
    for (let i = 0; i < depth; i++)
      formulas[`f${i}`] = [new Quad(a, a, a), new Quad(p, p, i + 1 < depth ? new BlankNode(`f${i + 1}`) : p), new Quad(a, p, a)];
    const writer = new FullWriter({ format: 'N3', formulas });
    writer.addQuad(p, p, new BlankNode('f0'));
    const output = await end(writer);
    expect(output).toBe(`<urn:p> <urn:p> ${'{ <urn:a> <urn:a> <urn:a>; <urn:p> <urn:a>. <urn:p> <urn:p> '.repeat(depth)}<urn:p>${' }'.repeat(depth)}.\n`);
  });

  it('should only expand blank nodes whose labels are formulas of their own', async () => {
    const writer = new FullWriter({ format: 'N3', formulas: { f: [] } });
    writer.addQuad(new Variable('f'), new NamedNode('http://ex.org/p'), new BlankNode('toString'));
    writer.addQuad(new BlankNode('constructor'), new NamedNode('http://ex.org/p'), new BlankNode('f'));
    expect(await end(writer)).toBe('?f <http://ex.org/p> _:toString.\n_:constructor <http://ex.org/p> {}.\n');
  });

  it('should refuse formulas in formats other than N3, and together with the lists option', () => {
    const formulas = { f: [] };
    expect(() => new FullWriter({ formulas })).toThrow('Cannot write formulas in formats other than N3');
    expect(() => new FullWriter({ format: 'N-Quads', formulas })).toThrow('Cannot write formulas in formats other than N3');
    expect(() => new FullWriter({ format: 'TriG', formulas })).toThrow('Cannot write formulas in formats other than N3');
    expect(() => new FullWriter({ format: 'N3', formulas, lists: {} })).toThrow('Cannot write formulas with the lists option');
    expect(new FullWriter({ format: 'text/n3', formulas })).toBeInstanceOf(Writer);
  });

  it('should refuse blank(), list() and their nodes together with formulas', () => {
    const p = new NamedNode('urn:p'), message = 'Cannot use nodes created by blank() or list() once formulas are in use';
    const writer = new FullWriter({ format: 'N3', formulas: { f: [] } }), other = new Writer({ format: 'N3' });
    expect(() => writer.blank()).toThrow(message);
    expect(() => writer.blank(p, p)).toThrow(message);
    expect(() => writer.list()).toThrow(message);
    expect(() => writer.list([p])).toThrow(message);
    expect(() => writer.addQuad(other.blank(), p, new BlankNode('f'))).toThrow(message);
    expect(() => writer.addQuad(p, p, new Quad(p, p, other.list([p])))).toThrow(message);
    let error;
    writer.addQuad(p, other.blank(p, p), p, new DefaultGraph(), e => { error = e; });
    expect(error).toEqual(new Error(message));
    expect(() => writer.addQuad(p, p, new Quad(p, p, p, other.blank()))).toThrow(message);
  });

  it('should refuse blank() and list() nodes inside formulas', async () => {
    const p = new NamedNode('urn:p'), other = new Writer({ format: 'N3' });
    const writer = new FullWriter({ format: 'N3', formulas: { f: [new Quad(p, p, other.blank())] } });
    writer.addQuad(p, p, new BlankNode('f'));
    await expect(end(writer)).rejects.toThrow('Cannot use nodes created by blank() or list() once formulas are in use');
  });

  it('should refuse named graphs together with formulas', async () => {
    const [b, p, g] = [new BlankNode('b'), new NamedNode('urn:p'), new NamedNode('urn:g')];
    const message = 'Cannot write named graphs once formulas are in use';
    const writer = new FullWriter({ format: 'N3', formulas: { f: [] } });
    expect(() => writer.addQuad(p, p, new BlankNode('f'), g)).toThrow(message);
    expect(() => writer.addQuad(p, p, p, new BlankNode('f'))).toThrow(message);
    expect(() => writer.addQuads([new Quad(p, p, p, g)])).toThrow(message);
    expect(() => writer.addQuad(p, p, new Quad(p, p, b, g))).toThrow(message);
    expect(() => writer.addQuad(p, p, new Quad(p, p, p, new BlankNode('f')))).toThrow(message);
    let error;
    writer.addQuad(p, p, p, b, e => { error = e; });
    expect(error).toEqual(new Error(message));
    writer.addQuad(p, p, new BlankNode('f'), e => { error = e; });
    expect(error).toBeUndefined();
    expect(await end(writer)).toBe('<urn:p> <urn:p> {}.\n');
    const nested = new FullWriter({ format: 'N3', formulas: { f: [new Quad(p, p, new Quad(p, p, p, g))] } });
    nested.addQuad(p, p, new BlankNode('f'));
    await expect(end(nested)).rejects.toThrow(message);
  });

  it('should not record the blank nodes of refused statements', async () => {
    const [b, c, p] = [new BlankNode('b'), new BlankNode('c'), new NamedNode('urn:p')];
    const writer = new FullWriter({ format: 'N3', formulas: { f: [new Quad(c, p, p)] } });
    expect(() => writer.addQuad(c, p, p, new NamedNode('urn:g'))).toThrow('Cannot write named graphs once formulas are in use');
    expect(() => writer.addQuad(c, p, new Writer().blank())).toThrow('Cannot use nodes created by blank() or list()');
    writer.addQuad(b, p, new BlankNode('f'));
    expect(await end(writer)).toBe('_:b <urn:p> { _:c <urn:p> <urn:p> }.\n');
  });

  it('should refuse a blank node shared by a formula and a formula inside it', async () => {
    const [b, p] = [new BlankNode('b'), new NamedNode('urn:p')];
    for (const formulas of [
      { f: [new Quad(b, p, new BlankNode('g'))], g: [new Quad(b, p, p)] },
      { f: [new Quad(new BlankNode('g'), p, b)], g: [new Quad(p, p, new Quad(b, p, p))] },
      { f: [new Quad(b, p, p), new Quad(p, p, new BlankNode('g'))], g: [new Quad(b, p, p)] },
    ]) {
      const writer = new FullWriter({ format: 'N3', formulas });
      writer.addQuad(p, p, new BlankNode('f'));
      await expect(end(writer)).rejects.toThrow('Cannot write blank node _:b both inside and outside a formula');
    }
  });

  it('should refuse a blank node shared by two formulas', async () => {
    const [b, p, q] = [new BlankNode('b'), new NamedNode('urn:p'), new NamedNode('urn:q')];
    const writer = new FullWriter({ format: 'N3', formulas: { f: [new Quad(b, p, p)], g: [new Quad(b, q, q)] } });
    writer.addQuad(new BlankNode('f'), p, new BlankNode('g'));
    await expect(end(writer)).rejects.toThrow('Cannot write blank node _:b both inside and outside a formula');
  });

  it('should refuse formulas that contain themselves', async () => {
    const p = new NamedNode('urn:p'), [f, g] = [new BlankNode('f'), new BlankNode('g')];
    for (const formulas of [
      { f: [new Quad(p, p, f)] },
      { f: [new Quad(p, p, new Quad(f, p, p))] },
      { f: [new Quad(p, p, g)], g: [new Quad(f, p, p)] },
    ]) {
      const writer = new FullWriter({ format: 'N3', formulas });
      writer.addQuad(p, p, f);
      await expect(end(writer)).rejects.toThrow('Cannot write formula _:f inside itself');
    }
  });

  it('should only serialize formulas in statements', () => {
    const p = new NamedNode('urn:p'), writer = new FullWriter({ format: 'N3', formulas: { f: [] } });
    expect(() => writer.quadToString(p, p, new BlankNode('f'))).toThrow('Cannot serialize formulas outside of statements');
    expect(writer.quadToString(p, p, p)).toBe('<urn:p> <urn:p> <urn:p> .\n');
  });

  it('should refuse to rebind a prefix once formulas are in use', async () => {
    const p = new NamedNode('urn:old:p'), f = new BlankNode('f');
    const writer = new FullWriter({ format: 'N3', prefixes: { ex: 'urn:old:' }, formulas: { f: [new Quad(p, p, p)] } });
    const message = 'Cannot rebind prefix ex: once formulas are in use';
    expect(() => writer.addPrefix('ex', 'urn:new:')).toThrow(message);
    expect(() => writer.addPrefixes({ ex: new NamedNode('urn:new:') })).toThrow(message);
    writer.addPrefix('ex', 'urn:old:');
    writer.addPrefix('alias', 'urn:old:');
    writer.addQuad(p, p, f);
    expect(await end(writer)).toBe('@prefix ex: <urn:old:>.\n\n@prefix ex: <urn:old:>.\n\n@prefix alias: <urn:old:>.\n\n' +
      'alias:p alias:p { alias:p alias:p alias:p }.\n');
  });

  it('should stay closed after a failed end, and end the output stream unless asked not to', async () => {
    const p = new NamedNode('urn:p'), f = new BlankNode('f'), formulas = { f: [new Quad(p, p, f)] };
    const message = 'Cannot write formula _:f inside itself';
    const writer = new FullWriter({ format: 'N3', formulas });
    writer.addQuad(p, p, f);
    await expect(end(writer)).rejects.toThrow(message);
    await expect(end(writer)).rejects.toThrow(message);
    let error;
    writer.addQuad(p, p, p, new DefaultGraph(), e => { error = e; });
    expect(error).toEqual(new Error('Cannot write because the writer has been closed.'));
    expect(() => writer.end()).toThrow(message);
    for (const options of [{}, { end: false }]) {
      const chunks = [];
      const stream = { ended: false, write(chunk, encoding, done) { chunks.push(chunk); done && done(); } };
      stream.end = () => { stream.ended = true; };
      const streamed = new FullWriter(stream, { format: 'N3', formulas, ...options });
      streamed.addQuad(p, p, p);
      streamed.addQuad(p, p, f);
      let endError;
      streamed.end(e => { endError = e; });
      expect(endError).toEqual(new Error(message));
      expect(stream.ended).toBe(options.end !== false);
      expect(chunks.join('')).toBe('<urn:p> <urn:p> <urn:p>.\n');
    }
    const throwing = new FullWriter({ write(chunk, encoding, done) { done && done(); }, end() { throw new Error('end'); } },
      { format: 'N3', formulas });
    throwing.addQuad(p, p, f);
    await expect(end(throwing)).rejects.toThrow(message);
  });

  it('should leave blank nodes that are no formula unchanged', async () => {
    const writer = new FullWriter({ format: 'N3', formulas: {} });
    writer.addQuad(new BlankNode('b'), new NamedNode('http://ex.org/p'), new BlankNode('c'));
    expect(await end(writer)).toBe('_:b <http://ex.org/p> _:c.\n');
  });

  it('should write blank() and list() nodes without formulas', async () => {
    const p = new NamedNode('urn:p'), writer = new FullWriter();
    writer.addQuad(writer.blank(p, p), p, writer.list([p]));
    expect(await end(writer)).toBe('[ <urn:p> <urn:p> ] <urn:p> (<urn:p>).\n');
  });

  it('should refuse terms without an RDF/JS term type, such as nodes from another copy of N3.js', () => {
    const p = new NamedNode('urn:p'), message = 'Cannot use nodes created by blank() or list() once formulas are in use';
    const writer = new FullWriter({ format: 'N3', formulas: { f: [] } }), node = { id: '[]', value: '[]' };
    expect(() => writer.addQuad(node, p, p)).toThrow(message);
    expect(() => writer.addQuad(p, p, { subject: p, predicate: p, object: p, termType: 'Quad' })).toThrow(message);
  });

  it('should limit the nesting of quoted triples', async () => {
    const p = new NamedNode('urn:p'), f = new BlankNode('f');
    let term = p;
    for (let i = 0; i < 256; i++)
      term = new Quad(p, p, term);
    const writer = new FullWriter({ format: 'N3', formulas: { f: [new Quad(p, p, term)] } });
    writer.addQuad(term, p, f);
    expect(await end(writer)).toMatch(/^<<\(/);
    const message = 'Cannot write quoted triples nested more than 256 levels deep once formulas are in use';
    const deeper = new Quad(p, p, term);
    expect(() => new FullWriter({ format: 'N3', formulas: { f: [] } }).addQuad(deeper, p, f)).toThrow(message);
    const nested = new FullWriter({ format: 'N3', formulas: { f: [new Quad(p, p, deeper)] } });
    nested.addQuad(p, p, f);
    await expect(end(nested)).rejects.toThrow(message);
  });

  it('should tell terms apart by type when grouping statements', async () => {
    const [p, a, b] = ['p', 'a', 'b'].map(name => new NamedNode(`urn:${name}`));
    const formulas = { f: [new Quad(new Variable('x'), p, a), new Quad(new NamedNode('?x'), p, b),
      new Quad(p, p, new Quad(new Variable('x'), p, a)), new Quad(p, p, new Quad(new NamedNode('?x'), p, a))] };
    const writer = new FullWriter({ format: 'N3', formulas });
    writer.addQuad(p, p, new BlankNode('f'));
    expect(await end(writer)).toBe('<urn:p> <urn:p> { ?x <urn:p> <urn:a>. <?x> <urn:p> <urn:b>. ' +
      '<urn:p> <urn:p> <<(?x <urn:p> <urn:a>)>>, <<(<?x> <urn:p> <urn:a>)>> }.\n');
  });

  it('should end only after the formulas were written to an asynchronous stream', async () => {
    const p = new NamedNode('urn:p'), f = new BlankNode('f'), formulas = { f: [] };
    for (const options of [{}, { end: false }]) {
      const callbacks = [], events = [];
      const stream = { write(chunk, encoding, done) { events.push('write'); done && callbacks.push(done); },
        end(done) { events.push('end'); done(); } };
      const writer = new FullWriter(stream, { format: 'N3', formulas, ...options });
      writer.addQuad(p, p, f);
      const done = jest.fn();
      writer.end(done);
      expect(done).not.toHaveBeenCalled();
      callbacks.forEach(callback => callback());
      callbacks.forEach(callback => callback());
      expect(done).toHaveBeenCalledTimes(1);
      expect(done.mock.calls[0][0]).toBeNull();
      expect(events).toEqual(options.end === false ? ['write'] : ['write', 'end']);
    }
  });

  it('should report errors of the output stream when ending', async () => {
    const p = new NamedNode('urn:p'), f = new BlankNode('f'), formulas = { f: [] };
    const failing = (write, endStream) => {
      const stream = { ended: 0, write, end(done) { stream.ended++; endStream && endStream(done); } };
      return stream;
    };
    // An asynchronous write error
    let stream = failing((chunk, encoding, done) => done && done(new Error('write')));
    let writer = new FullWriter(stream, { format: 'N3', formulas });
    writer.addQuad(p, p, f);
    await expect(end(writer)).rejects.toThrow('write');
    await expect(end(writer)).rejects.toThrow('write');
    expect(stream.ended).toBe(1);
    // A synchronous write error
    stream = failing(() => { throw new Error('thrown'); });
    writer = new FullWriter(stream, { format: 'N3', formulas });
    writer.addQuad(p, p, f);
    expect(() => writer.end()).toThrow('thrown');
    // An error ending the stream, thrown or passed to its callback
    for (const endStream of [() => { throw new Error('end'); }, done => done(new Error('end')),
      done => { done(new Error('end')); done(); }]) {
      stream = failing((chunk, encoding, done) => done && done(), endStream);
      writer = new FullWriter(stream, { format: 'N3', formulas });
      writer.addQuad(p, p, f);
      await expect(end(writer)).rejects.toThrow('end');
      expect(stream.ended).toBe(1);
    }
    // Without formulas
    stream = failing(() => {}, () => { throw new Error('end'); });
    await expect(end(new FullWriter(stream))).rejects.toThrow('end');
    const open = new FullWriter(failing(() => {}), { end: false });
    expect(await end(open)).toBeUndefined();
    // An error thrown by the callback itself
    writer = new FullWriter({ format: 'N3', formulas });
    writer.addQuad(p, p, f);
    expect(() => writer.end(() => { throw new Error('callback'); })).toThrow('callback');
  });
});
