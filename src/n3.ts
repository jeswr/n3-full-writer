// Typed handles on the N3.js runtime exports this package builds on.
import { Term, Writer, termToId as untypedTermToId } from 'n3';
import type * as RDF from '@rdfjs/types';
import type { N3Term as TermType, N3Writer as WriterType } from './n3-internals.js';

export const N3Term = Term as typeof TermType;
export const N3Writer = Writer as typeof WriterType;
export const termToId = untypedTermToId as (term: RDF.Term) => string;
