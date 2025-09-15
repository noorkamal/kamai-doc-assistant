declare module "mammoth";
declare module "fast-xml-parser";
declare module "pdfjs-dist/legacy/build/pdf.js" {
  // minimal typing for the node-friendly pdfjs export surface we use
  export const GlobalWorkerOptions: {
    workerSrc: string;
    // allow any other props
    [k: string]: any;
  };
  export function getDocument(src: any): {
    promise: Promise<any>;
    // other runtime props are not needed for typing
    [k: string]: any;
  };
  export default any;
}
