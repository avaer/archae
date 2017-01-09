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
