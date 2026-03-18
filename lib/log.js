const isDev = process.env.NODE_ENV === 'development';
export const log = (...args) => isDev && console.log(...args);
