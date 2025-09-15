// Minimal shims for untyped libs used by api/extract.ts

declare module "mammoth" {
  const mammoth: any;
  export default mammoth;
}

declare module "fast-xml-parser" {
  const fx: any;
  export const XMLParser: any;
  export default fx;
}

declare module "pdfjs-dist" {
  const pdfjs: any;
  export default pdfjs;
}

declare module "pdfjs-dist/legacy/build/pdf" {
  export const GlobalWorkerOptions: any;
  export function getDocument(src: any): { promise: Promise<any>; };
  const _default: any;
  export default _default;
}

declare module "pdfjs-dist/legacy/build/pdf.js" {
  export const GlobalWorkerOptions: any;
  export function getDocument(src: any): { promise: Promise<any>; };
  const _default: any;
  export default _default;
}
