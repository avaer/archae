# Archae

A full-stack Javascript plugin system for modern web apps, built around `npm`.

Archae was originally built for the needs of hot-loading virtual reality (WebVR) plugins for [`zeo`](https://modules.io/zeo), but it's application-agnostic. As long as your stack involves `node` and a browser.

Archae is well-suited for complex web applications that want to dynamically load functionality across the server/client/worker barrier. Examples include multi-user apps, resource/network-heavy user interfaces, and any app in which getting the pieces working together is a thing you're thinking about.

It's less well-suited for simple static CRUD apps. In that case you probably just want a web framework and a bundler.

#### Installation
```sh
npm install archae # requires node 6+
```

#### Run the demo
```sh
npm start # run demo on https://localhost:8000/
```

## Description

Archae lets you install (and remove) functionality atomically on your live web app, whether your code needs to run on the server or client. Archae _plugins_ are just `npm` modules written for _engines_ (also npm modules). As long as your `npm` module exposes a function to `mount` and `unmount` on the client and/or server (both optional), `archae` will automagically server and load it.

Notable features:

- Built around `npm`
- ES6 support
- `require`, `module.exports`, `import`, `export`
- HTTP/2 required
- Automatic bundling
- Isomorphic API on both client and server

## Example: server-side `left-pad`!

#### package.json
```json
{
  "name": "demo-plugin",
  "client": "client.js",
  "server": "server.js",
  "dependencies": {
    "left-pad": "^1.1.3"
  }
}
```

#### server.js
```js
const leftPad = require('left-pad');

module.exports = class DemoPlugin {
  constructor(archae) {
    this.archae = archae;
  }

  mount() {
    const {archae} = this;
    const {express, app} = archae.getCore();

    function serveLeftPad(req, res, next) {
      const n = parseInt(req.get('left-pad'), 10) || 0;

      let s = '';
      req.setEncoding('utf8');
      req.on('data', data => {
        s += data;
      });
      req.on('end', () => {
        res.send(leftPad(s, s.length + n));
      });
    }
    app.post('/left-pad', serveLeftPad);

    this._cleanup = () => {
      function removeMiddlewares(route, i, routes) {
        if (route.handle.name === 'serveLeftPad') {
          routes.splice(i, 1);
        }
        if (route.route) {
          route.route.stack.forEach(removeMiddlewares);
        }
      }
      app._router.stack.forEach(removeMiddlewares);
    };
  }

  unmount() {
    this._cleanup();
  }
};
```

#### client.js
```js
module.exports = archae => ({
  mount() {
    const element = (() => {
      const element = document.createElement('form');

      const textLabel = document.createElement('label');
      textLabel.innerHTML = 'Input text: ';
      textLabel.style.marginRight = '10px';
      const text = document.createElement('input');
      text.type = 'text';
      text.value = 'Blah blah';
      text.placeholder = 'Enter some text';
      textLabel.appendChild(text);
      element.appendChild(textLabel);

      setTimeout(() => {
        text.focus();
      });

      const numberLabel = document.createElement('label');
      numberLabel.innerHTML = 'Padding: ';
      const number = document.createElement('input');
      number.type = 'number';
      number.value = 10;
      numberLabel.appendChild(number);
      element.appendChild(numberLabel);

      const submit = document.createElement('input');
      submit.type = 'submit';
      submit.value = 'Left-pad it on the server!';
      submit.style.display = 'block';
      submit.style.margin = '10px 0';
      element.appendChild(submit);

      const result = document.createElement('textarea');
      result.style.width = '400px';
      result.style.height = '200px';
      element.appendChild(result);

      element.addEventListener('submit', e => {
        fetch('/left-pad', {
          method: 'POST',
          headers: {
            'left-pad': number.value,
          },
          body: text.value,
        })
          .then(res => res.text()
            .then(s => {
              result.value = s;
            })
          )
          .catch(err => {
            console.warn(err);
          });

        e.preventDefault();
      });

      return element;
    })();
    this.element = element;

    document.body.appendChild(element);
  },
  unmount() {
    document.body.removeChild(this.element);
  }
});
```

This example is in `/example/plugins/demo-plugin`. You can run it with `npm start` in the repository root.

## How it works

Arche pulls, builds, loads, and caches `npm` modules on the backend, and serves them to the frontend over HTTP/2, as long as they meet the above `mount`/`unmount` spec.

All you have to do to use archae is instantiate it in your app:

#### index.js
```js
const archae = require('archae');

const a = archae();
a.listen(err => {
  if (!err) {
    console.log('https://localhost:8000/');
  } else {
    console.warn(err);
  }
});
console.log('server-side Archae API:', a);
```

...and then load it on your frontend:

#### index.html
```html
<!DOCTYPE html>
<html>
<body>
  <script src="/archae/archae.js"></script>
  <script>
    console.log('client-side Archae API:', archae);
  </script>
</body>
</html>
```

From here, you can use the `archae` API to `request` (load) and `release` (unload) plugins. The API is isomorphic and works the same both the frontend and backend. It's built around the `Promise` API:

## Archae API

#### getCore() : `Object`

// XXX

#### requestPlugin(pluginPath) : `Promise(pluginApi : Object)`

// XXX

#### releasePlugin() : `Promise()`

// XXX
