// Ambient declaration (no imports — must stay a global module file).
declare module "*.sql?raw" {
  const content: string;
  export default content;
}
