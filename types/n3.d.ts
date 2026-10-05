// N3.js ships no type declarations. src/n3.ts gives the members this package
// uses their types; this declaration only lets it import them.
declare module 'n3' {
  export const Term: unknown;
  export const Writer: unknown;
}
