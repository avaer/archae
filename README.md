# Archae

A full-stack Javascript plugin system for modern web apps, built around `npm`.

Archae was originally built for the needs of hot-loading virtual reality (WebVR) plugins for [`zeo`](https://modules.io/zeo), but it's stack-agnostic. As long as your stack involves `node` and a browser.

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

## How it works

Archae is a library that loads _plugins_. Archae _plugins_ are just `npm` modules with some keys in the `package.json` that tell Archae which `.js` file to load, and where -- `client`, `server`, or `worker`, all optional. Your `.js` file exports a `mount` and `unmount` callback that will be called when your plugin is loaded or needs to be unloaded.

That's it! If your `npm` module meets this spec, it's an Archae _plugin_ that can be loaded into your app.

## Features

- Pure JS, only dependency is `node` and `npm`
- ES6 support
- Automatic bundling with `rollup`
- HTTP/2
- `require`, `module.exports`, `import`, `export` anything from `npm` the usual way
- Isomorphic API on both client and server

## Example plugin: server-side `left-pad`!

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

This example is in [`example/plugins/demo-plugin`](https://github.com/modulesio/archae/tree/master/example/plugins/demo-plugin). You can run it with `npm start` in the repository root.

## How it works

Archae pulls, builds, loads, and caches `npm` modules on the backend, and serves them to the frontend over HTTP/2, as long as they meet the above `mount`/`unmount` spec.

All you have to do to use Archae is instantiate it in your app:

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

From here, you can use the `archae` API to `request` (load) and `release` (unload) plugins. The API is isomorphic and works the same both the frontend and backend. It's built around the `Promise` API. Plugins also may also `request` each other and _export_ APIs to communicate with each other. This is all documented below.

## Archae constructor

To use `archae`, you first need construct and instance of it on your server. Here's an example with all of the arguments and their defaults:

#### index.js
```js
const archae = require('archae');

const a = archae({
  dirname: process.cwd(), // the root directory against which `archae` will resolve paths
  hostname: 'archae',     // the hostname to use for autogenerated certificates
                          // if you want to use your own (recommended), see below
                          // in that case, `hostname` will be ignored
  host: null,             // the hostname to bind to -- either an IP or an actual DNS name
                          // this need not be the same as the `hostname`
  port: 8000,             // the port to bind to; note that if it's < 1024 you need root
  publicDirectory: null,  // an optional public directory to serve
  dataDirectory: 'data',  // a directory (under `dirname`) to use for data storage
  server: null,           // an `https` server instance to use; if not provided will be created
  app: null,              // an `express` app instance to use; if not provided will be created
  wss: null,              // a `wss` websocket server to use; if not provided will be created
});
a.listen(err => {
  if (!err) {
    console.log('archae listening');
  } else {
    console.warn(err);
  }
});
```

Once the `listen` callback returns, you'll know your server is ready to accept connections on `https://<host>:<port>`.

Note the `https://`. Archae uses HTTP/2 server by default (for security and speed) will automatically generate a certificate for you if you don't provide one. However, these will almost certainly (rightfully) be rejected by most browsers, so it is recommended that you use your own. See below.

### Custom TLS certs

Archae supports using standard TLS certificates for your domain. If you have a domain name you can get a free TLS certificate for it from [Let's Encrypt](https://letsencrypt.org/), but virtually any certificate signed by any standard certificate authority will work.

Certificates boil down to two files: the public certificate in `cert.pem` , and a private key for decrypting connections in `private.pem` (which must be kept secret!). Archae keeps these files in `<dirname>/<dataDiectory>/crypto/{cert,private}.pem`, which in the default configuration (see above) is `data/crypto/{cert,private.pem}`.

Put your certificates there and restart the server; they will be picked up automatically. If this directory does not exist, either create it or run `archae` once, which will create the directory and seed it with autogenerated certificates that you can replace with your own. Make sure that whatever ownership/permissions you have on those files can be read by the `node` process running `archae`!

### Serving Archae on the frontend

Once you've started the Archae server you probably want to load up the main `archae.js` script on the frontend. This script is automatically served at `https://<host>:<port>/archae/archae.js` by the Archae server you have running.

You can load this script any way you like, but the recommended way is to just use `<script src="/archae/archae.js"></script>` at the end of your `<body>` in your `index.html`. See [`example/public/index.html`](https://github.com/modulesio/archae/tree/master/example/public/index.html) for a working example, which you can run with `npm start`.

This will get you the Archae API as a global variable (`window.archae` or just `archae`) in the browser, and you'll already have the `archae` server instance on the backend. Additionally, the `archae` API will be available to any plugin you load. In all cases, the API is the same.

## Archae API

This describes the API you have on the client server, and every plugin that Archae loads.

#### requestPlugin(pluginPath) : `Promise(pluginApi : Object)`

This is the function you call to load an Archae plugin. There is only one method call required to load your plugin on all environments: `client`, `server`, and `worker`. No matter where you call it from, the result will be to load the plugin on all of the environments it is specified to run on (see the above spec).

The `pluginPath` is a `String` that can be either:

- an _absolute path_ that starts with `/`
- the name of an `npm` module

In either case, the return value of the function is a `Promise` that will eventually resolve to the plugin's _exported API_, or reject with an error describing how the loading process failed. Archae will figure out how to load the plugin in all environments and you won't get the callback until it's done.

For details of how your plugin can _export an API_ from its `mount` function, see below.

#### releasePlugin(`pluginPath`) : `Promise()`

This is the opposite of `requestPlugin`: it unloads the plugin specified by `pluginPath`. The format of `pluginPath` is the same as for `releasePlugin`, but in particular you should make sure that the string that you pass to `requestPlugin` is _exactly_ the same as the one you pass to `releasePlugin`.

The result of the function is a `Promise` that will resolve once the unload is done, or reject with an error describing how the unloading process failed.

#### getCore() : `Object`

Available only on the server and `"server"` plugin scripts, this gives you access to an object with the following shape:

```js
{
  express, // the `express` object that you can use for web framework functionality
  server,  // the `https` server that Archae is using to serve the browser
  app,     // the `express` app that is being used to serve Archae routes
  wss,     // the `wss` websocket server used to serve the browser websockets
  dirname, // the `dirname` that the server was configured with (see above)
}
```

In all cases you may use these APIs however you like, both on the server and in your plugins, with one restriction: a plugin using these APIs must clean up whatever it does in `mount` in its `unmount`.

For example, if your plugin is going to add a route to the `app` in `mount`, it must completely remove it in `unmount`. If you don't do this, your plugins will not mount/unmount cleanly and memory leaks and crashes are likely to result.

## Plugin exported APIs

Archae plugins may return an API to _export_ from their `mount` function. This lets other plugins communicate with that plugin when they `request` it.

For example, you might have a `database` plugin that _exports_ `get()` and `set()` so that other plugins can use the database. That might look something like this:

#### database/client.js
```js
export default class Database {
  mount() {
    return new Promise((accept, reject) => {
      const databaseInstance = {}; // load the database instance somehow...
      accept(databaseInstance);
    })
      .then(databaseInstance => {
        const databaseApi = {
          get(key) {
            return new Promise((accept, reject) => {
              // get the value from databaseApi and accept() it...
            });
          },
          set(key, value) {
            return new Promise((accept, reject) => {
              // set the value from databaseApi and accept() when done...
            });
          },
        };
      });
  }

  unmount() {}
}
```

#### some-other-plugin/client.js
```js
module.exports = archae => {
  mount() {
    return archae.requestPlugin('database')
      .then(database => {
        // call database.get() or database.set() here to use the database...
      });
  }

  unmount() {}
};
```

There is no restriction on what kind of value you may export from a plugin, but it's recommended to stick to plain `Object`s, and to document the API in your plugin's `README.md`.

## Contact

Issues and PR's are welcome. If you want to reach me privately, I'm Avaer Kazmer <a@modules.io>.
