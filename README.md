# n3-full-writer

A complete, non-streaming writer for [N3.js](https://github.com/rdfjs/N3.js)
that can write [N3](https://w3c.github.io/N3/spec/) formulas.

N3.js writes each statement as soon as it is added, so it cannot write a formula,
whose contents have to appear in full wherever the formula is used.
`FullWriter` extends `N3.Writer` and holds back the statements that use formulas until `end()`,
then writes each formula once, in place.
Statements without formulas are still written as they arrive.

This code was proposed for N3.js in
[rdfjs/N3.js#822](https://github.com/rdfjs/N3.js/pull/822),
and lives here while its design settles.
It is experimental: it overrides private N3.js Writer methods,
so it supports only the `n3` versions in its `peerDependencies`,
and refuses to load if the members it relies on are missing.
It extends `N3.Writer` only, so it does not work through `N3.StreamWriter`.

## Install

```sh
npm install n3 n3-full-writer
```

The package is written in TypeScript and ships its type declarations.

## Usage

Pass the quads of each formula in the `formulas` option, keyed by the label of the blank node that stands for it.
Every other option, and every method, is the same as for `N3.Writer`.

```js
import { DataFactory, Parser } from 'n3';
import FullWriter from 'n3-full-writer';

const { namedNode, blankNode, quad } = DataFactory;
const p = namedNode('http://example.org/p');

const writer = new FullWriter({
  format: 'N3',
  prefixes: { ex: 'http://example.org/' },
  formulas: { f: [quad(p, p, p)] },
});
writer.addQuad(namedNode('http://example.org/alice'), namedNode('http://example.org/says'), blankNode('f'));
writer.end((error, result) => console.log(result));
// @prefix ex: <http://example.org/>.
//
// ex:alice ex:says { ex:p ex:p ex:p }.
```

The N3.js parser puts the quads of a formula in a graph named by the formula's blank node,
so a parsed document is written back by grouping its quads by graph.
An empty formula `{}` has no quads, so it is not found this way;
give the labels of known empty formulas an empty array.

```js
const formulas = {}, statements = [];
for (const quad of new Parser({ format: 'N3' }).parse('{ ?s a ?o } => { ?s a ?o }.')) {
  if (quad.graph.termType === 'BlankNode')
    (formulas[quad.graph.value] ||= []).push(quad);
  else
    statements.push(quad);
}
const writer = new FullWriter({ format: 'N3', formulas });
writer.addQuads(statements);
writer.end((error, result) => console.log(result));
// { ?s a ?o } <http://www.w3.org/2000/10/swap/log#implies> { ?s a ?o }.
```

## What it writes

- Formulas in any position, nested to any depth (without recursion), and inside lists and quoted triples.
- Each formula exactly once. A formula used by several statements becomes their subject,
  with inverse `is … of` verbs where it is the object.
- Blank nodes in the scope of one formula only, as N3 scopes blank node labels to their formula.

Any `formulas` option, even `{}`, turns on these restrictions.
The writer refuses, with an error, what it cannot write faithfully:

- formats other than N3, and the `lists` option (write lists as `rdf:first` and `rdf:rest` statements);
- named graphs, and nodes from `blank()` or `list()` or anything else that is not an RDF/JS term;
- quoted triples nested more than 256 levels deep;
- a formula inside itself, or a formula that would have to be written more than once;
- a blank node used both inside and outside a formula;
- rebinding a prefix to another IRI.

Statements are checked when they are added. Errors in formulas themselves only show at `end()`,
when statements without formulas may already have been written to the output.
The callback of a statement with formulas only acknowledges that the statement was held back.

`end()` writes the held-back statements and then behaves exactly like `N3.Writer#end`,
including how it reports errors of the output stream.
Formulas that cannot be written are reported before any of them is written:
to the `end` callback, or thrown without one.
The writer is then closed, and reports the same error on later calls to `end()`.

## Development

Use Node.js 22.18+ or 24.11+:

```sh
npm ci
npm test
npm run lint
npm run build
```

Releases are published from `main` by semantic-release through npm trusted publishing.

## License

MIT. The implementation comes from N3.js and retains the N3.js contributors' copyright;
see [LICENSE.md](./LICENSE.md).
