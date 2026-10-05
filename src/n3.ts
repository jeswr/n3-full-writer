// Typed handles on the N3.js runtime exports this package builds on.
import { Term, Writer } from 'n3';
import type { N3Term as TermType, N3Writer as WriterType } from './n3-internals.js';

export const N3Term = Term as typeof TermType;
export const N3Writer = Writer as typeof WriterType;

// This package overrides and calls private members of the N3.js Writer,
// so it refuses to load with an N3.js version where these are missing
const writerMethods = ['_write', '_blockedWrite', '_endStatement', '_writeQuad', '_encodeSubject',
  '_encodePredicate', '_encodeObject', '_encodeIriOrBlank', 'addPrefixes', 'blank', 'list', 'end'];
const probe = new N3Writer() as unknown as Record<string, unknown>;
if (writerMethods.some(name => typeof probe[name] !== 'function') ||
    typeof probe._outputStream !== 'object' || typeof probe._endStream !== 'boolean' ||
    new N3Term('x').id !== 'x')
  throw new Error('n3-full-writer does not support this version of n3; see its peerDependencies');
