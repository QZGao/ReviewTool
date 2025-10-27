// global.d.ts at package root - allow importing CSS files as strings
declare module '*.css' {
    const content: string;
    export default content;
}

