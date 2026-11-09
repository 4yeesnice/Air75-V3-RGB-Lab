// Vite bundles the module as a separate worker chunk and returns its URL.
declare module "*?worker&url" {
  const url: string;
  export default url;
}
