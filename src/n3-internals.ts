// Types for the N3.js runtime members this package relies on. N3.js ships no
// type declarations, and these include private members, so they are declared
// here rather than taken from @types/n3.
import type * as RDF from '@rdfjs/types';

// A stream the writer writes to, such as a Node.js stream.
export interface WriterOutputStream {
  write(chunk: string, encoding: 'utf8', done?: (error?: Error | null) => void): unknown;
  end(done?: (error?: Error | null, result?: string) => void): unknown;
}

export type Prefixes = Record<string, RDF.NamedNode | string>;

export interface WriterOptions {
  format?: string;
  prefixes?: Prefixes;
  baseIRI?: string;
  writeBase?: boolean;
  version?: string;
  lists?: Record<string, RDF.Term[]>;
  end?: boolean;
}

// Called when a statement was written, or with the error that refused it.
export type WriteCallback = (error?: Error | null) => void;
// Called when the writer has ended, with the output if no stream was given.
export type EndCallback = (error: Error | null | undefined, result?: string) => void;

// A term created by N3.js, which holds its serialization as `id`.
export declare class N3Term {
  constructor(id: string);
  readonly id: string;
  equals(other: RDF.Term | null | undefined): boolean;
}

export declare class N3Writer {
  constructor(outputStream?: WriterOutputStream | WriterOptions | null, options?: WriterOptions);
  protected _outputStream: WriterOutputStream;
  protected _endStream: boolean;
  protected _subject: RDF.Term | null;
  protected _write(text: string, done?: WriteCallback): void;
  protected _blockedWrite(): never;
  protected _endStatement(): void;
  protected _writeQuad(subject: RDF.Term, predicate: RDF.Term, object: RDF.Term, graph: RDF.Term,
    done?: WriteCallback): void;
  protected _encodeSubject(entity: RDF.Term): string;
  protected _encodePredicate(predicate: RDF.Term): string;
  protected _encodeObject(object: RDF.Term): string;
  protected _encodeIriOrBlank(entity: RDF.Term): string;
  quadToString(subject: RDF.Term, predicate: RDF.Term, object: RDF.Term, graph?: RDF.Term): string;
  quadsToString(quads: RDF.Quad[]): string;
  addQuad(quad: RDF.Quad, done?: WriteCallback): void;
  addQuad(subject: RDF.Term, predicate: RDF.Term, object: RDF.Term, done?: WriteCallback): void;
  addQuad(subject: RDF.Term, predicate: RDF.Term, object: RDF.Term, graph?: RDF.Term, done?: WriteCallback): void;
  addQuads(quads: RDF.Quad[]): void;
  addPrefix(prefix: string, iri: RDF.NamedNode | string, done?: WriteCallback): void;
  addPrefixes(prefixes: Prefixes, done?: WriteCallback): void;
  blank(predicate?: RDF.Term | { predicate: RDF.Term, object: RDF.Term } |
    { predicate: RDF.Term, object: RDF.Term }[], object?: RDF.Term): RDF.Term;
  list(elements?: RDF.Term[]): RDF.Term;
  end(done?: EndCallback): void;
}
