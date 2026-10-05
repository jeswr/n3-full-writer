// Type tests for the public API; `npm run lint` type-checks this file.
import type * as RDF from '@rdfjs/types';
import FullWriter from '../../src/index.js';
import type { Formulas } from '../../src/index.js';

declare const quad: RDF.Quad;
declare const term: RDF.Term;

const formulas: Formulas = { f: [quad] };
const writer = new FullWriter({ format: 'N3', formulas, prefixes: { ex: 'http://example.org/' } });
new FullWriter(process.stdout, { format: 'N3', formulas });

writer.addQuad(quad);
writer.addQuad(term, term, term);
writer.addQuads([quad]);
writer.addPrefix('ex', 'http://example.org/');
writer.end((error, result) => {
  const output: string | undefined = result;
});

// @ts-expect-error formulas are a map of quads
new FullWriter({ format: 'N3', formulas: { f: [term] } });
// @ts-expect-error the internals of the writer are not public
writer._write('');
