declare module '*.css' {
  const text: string;
  export default text;
}

// Island scripts under src/islands/ are raw text (wrangler Text rule) —
// browser code served to the page, never bundled as Worker modules.
declare module '*.js' {
  const text: string;
  export default text;
}
