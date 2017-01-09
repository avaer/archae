const archae = require('..');

const a = archae({
  dirname: __dirname,
  publicDirectory: 'public',
});
a.listen(err => {
  if (!err) {
    console.log('https://localhost:8000/');
  } else {
    console.warn(err);
  }
});
