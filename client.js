const path = require('path');
const WebSocket = require('ws/lib/WebSocket.js');

module.exports = ({protocol = 'http', host = '127.0.0.1', port = 8080} = {}) => {
  const window = global;
  const location = {
    protocol: protocol + ':',
    host: host + ':' + port,
    pathname: '/',
  };
  const _makeArchae = require(path.join(__dirname, 'lib', 'archae'));
  const ArchaeClient = _makeArchae({
    window,
    location,
    WebSocket,
  });
  const archae = new ArchaeClient();

  return archae;
};
