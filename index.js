const path = require('path');
const fs = require('fs-extra');
const child_process = require('child_process');

const express = require('express');
const ws = require('ws');
const mkdirp = require('mkdirp');
const rimraf = require('rimraf');

const nameSymbol = Symbol();

class ArchaeServer {
  constructor({server, app, wss} = {}) {
    server = server || http.createServer();
    app = app || express();
    wss = wss || new ws.Server({ server });

    this.server = server;
    this.app = app;
    this.wss = wss;

    this.connections = [];

    this.engines = {};
    this.engineInstances = {};
    this.engineApis = {};
    this.plugins = {};
    this.pluginInstances = {};
    this.pluginApis = {};

    this.mountApp();
  }

  requestEngine(engine, opts = {}) { // XXX implement locking for these
    return new Promise((accept, reject) => {
      const _remove = cb => {
        _removeModule(engine, 'engines', cb);
      };
      const _add = cb => {
        _addModule(engine, 'engines', (err, result) => {
          if (!err) {
            const {moduleName: engineName} = result;

            const existingEngine = this.engines[engineName];
            if (existingEngine !== undefined) {
              const engineApi = this.engineApis[engineName];
              cb(null, engineApi);
            } else {
              this.loadEngine(engineName, err => {
                if (!err) {
                  this.mountEngine(engineName, err => {
                    if (!err) {
                      const engineApi = this.engineApis[engineName];
                      cb(null, engineApi);
                    } else {
                      cb(err);
                    }
                  });
                } else {
                  cb(err);
                }
              });
            }
          } else {
            cb(err);
          }
        });
      };

      if (opts.force) {
        _remove(err => {
          if (!err) {
            _add((err, result) => {
              if (!err) {
                accept(result);
              } else {
                reject(err);
              }
            });
          } else {
            reject(err);
          }
        });
      } else {
        _add((err, result) => {
          if (!err) {
            accept(result);
          } else {
            reject(err);
          }
        });
      }
    });
  }

  requestEngines(engines, opts = {}) {
    const requestEnginePromises = engines.map(engine => this.requestEngine(engine, opts));
    return Promise.all(requestEnginePromises);
  }

  removeEngine(engine, opts = {}) {
    return new Promise((accept, reject) => {
      _removeModule(engine, 'engines', err => {
        if (!err) {
          accept();
        } else {
          reject(err);
        }
      });
    });
  }

  requestPlugin(plugin, opts = {}) {
    return new Promise((accept, reject) => {
      const _remove = cb => {
        _removeModule(plugin, 'plugins', cb);
      };
      const _add = cb => {
        _addModule(plugin, 'plugins', (err, result) => {
          if (!err) {
            const {added, moduleName: pluginName} = result;

            const existingPlugin = this.plugins[pluginName];
            if (existingPlugin !== undefined) {
              const pluginApi = this.pluginApis[pluginName];
              cb(null, pluginApi);
            } else {
              this.loadPlugin(pluginName, err => {
                if (!err) {
                  this.mountPlugin(pluginName, err => {
                    if (!err) {
                      const pluginApi = this.pluginApis[pluginName];
                      cb(null, pluginApi);
                    } else {
                      cb(err);
                    }
                  });
                } else {
                  cb(err);
                }
              });
            }
          } else {
            cb(err);
          }
        });
      };

      if (opts.force) {
        _remove(err => {
          if (!err) {
            _add((err, result) => {
              if (!err) {
                accept(result);
              } else {
                reject(err);
              }
            });
          } else {
            reject(err);
          }
        });
      } else {
        _add((err, result) => {
          if (!err) {
            accept(result);
          } else {
            reject(err);
          }
        });
      }
    });
  }

  requestPlugins(plugins, opts = {}) {
    const requestPluginPromises = plugins.map(plugin => this.requestPlugin(plugin, opts));
    return Promise.all(requestPluginPromises);
  }

  removePlugin(plugin, opts = {}) {
    return new Promise((accept, reject) => {
      _removeModule(plugin, 'plugins', err => {
        if (!err) {
          accept();
        } else {
          reject(err);
        }
      });
    });
  }

  getClientModules(cb) {
    let engines = [];
    let plugins = [];

    let pending = 2;
    const pend = () => {
      if (--pending === 0) {
        cb(null, {
          engines: _sort(engines),
          plugins: _sort(plugins),
        });
      }
    };
    const _sort = modules => modules.map(m => m.replace(/\.js$/, '')).sort();

    fs.readdir(path.join(__dirname, 'engines', 'build'), (err, files) => {
      if (!err) {
        engines = engines.concat(files);
      }

      pend();
    });
    fs.readdir(path.join(__dirname, 'plugins', 'build'), (err, files) => {
      if (!err) {
        plugins = plugins.concat(files);
      }

      pend();
    });
  }

  getServerModules(cb) {
    let engines = [];
    let plugins = [];

    let pending = 2;
    const pend = () => {
      if (--pending === 0) {
        cb(null, {
          engines: _sort(engines),
          plugins: _sort(plugins),
        });
      }
    };
    const _sort = modules => modules.map(m => m.replace(/\.js$/, '')).sort();

    fs.readdir(path.join(__dirname, 'engines', 'node_modules'), (err, files) => {
      if (!err) {
        if (files.length > 0) {
          let pending = files.length;
          const pend2 = () => {
            if (--pending === 0) {
              pend();
            }
          };

          files.forEach(file => {
            const engine = file;

            fs.readFile(path.join(__dirname, 'engines', 'node_modules', engine, 'package.json'), 'utf8', (err, s) => {
              if (!err) {
                const j = JSON.parse(s);
                const serverFileName = j.server;
                if (serverFileName) {
                  engines.push(engine);
                }

                pend2();
              } else {
                console.warn(err);

                pend2();
              }
            });
          });
        } else {
          pend();
        }
      } else if (err.code === 'ENOENT') {
        pend();
      } else {
        console.warn(err);

        pend();
      }
    });
    fs.readdir(path.join(__dirname, 'plugins', 'build'), (err, files) => {
      if (!err) {
        if (files.length > 0) {
          let pending = files.length;
          const pend2 = () => {
            if (--pending === 0) {
              pend();
            }
          };

          files.forEach(file => {
            const plugin = file.replace(/\.js$/, '');

            fs.readFile(path.join(__dirname, 'plugins', 'node_modules', plugin, 'package.json'), 'utf8', (err, s) => {
              if (!err) {
                const j = JSON.parse(s);
                const serverFileName = j.server;
                if (serverFileName) {
                  plugins.push(plugin);
                }

                pend2();
              } else {
                console.warn(err);

                pend2();
              }
            });
          });
        } else {
          pend();
        }
      } else if (err.code === 'ENOENT') {
        pend();
      } else {
        console.warn(err);

        pend();
      }
    });
  }

  loadEngine(engine, cb) {
    fs.readFile(path.join(__dirname, 'engines', 'node_modules', engine, 'package.json'), 'utf8', (err, s) => {
      if (!err) {
        const j = JSON.parse(s);
        const {client: clientFileName, server: serverFileName} = j;
        if (serverFileName) {
          const engineModule = require(path.join(__dirname, 'engines', 'node_modules', engine, serverFileName));

          this.engines[engine] = engineModule;
        } else {
          this.engines[engine] = null;
        }

        cb();
      } else {
        cb(err);
      }
    });
  }

  mountEngine(engine, cb) {
    const engineModule = this.engines[engine];

    if (engineModule !== null) {
      Promise.resolve(engineModule(this))
        .then(engineInstance => {
          this.engineInstances[engine] = engineInstance;

          Promise.resolve(engineInstance.mount())
            .then(engineApi => {
              if (typeof engineApi !== 'object' || engineApi === null) {
                engineApi = {};
              }
              engineApi[nameSymbol] = engine;

              this.engineApis[engine] = engineApi;

              cb();
            })
            .catch(err => {
              this.engineApis[engine] = null;

              cb(err);
            });
        })
        .catch(err => {
          this.engineInstances[engine] = null;
          this.engineApis[engine] = null;

          cb(err);
        });
    } else {
      this.engineInstances[engine] = {};
      this.engineApis[engine] = {
        [nameSymbol]: engine,
      };

      cb();
    }
  }

  loadPlugin(plugin, cb) {
    fs.readFile(path.join(__dirname, 'plugins', 'node_modules', plugin, 'package.json'), 'utf8', (err, s) => {
      if (!err) {
        const j = JSON.parse(s);
        const {client: clientFileName, server: serverFileName} = j;
        if (serverFileName) {
          const pluginModule = require(path.join(__dirname, 'plugins', 'node_modules', plugin, serverFileName));

          this.plugins[plugin] = pluginModule;
        } else {
          this.plugins[plugin] = null;
        }

        cb();
      } else {
        cb(err);
      }
    });
  }

  mountPlugin(plugin, cb) {
    const pluginModule = this.plugins[plugin];

    if (pluginModule !== null) {
      Promise.resolve(pluginModule(this))
        .then(pluginInstance => {
          this.pluginInstances[plugin] = pluginInstance;

          Promise.resolve(pluginInstance.mount())
            .then(pluginApi => {
              if (typeof pluginApi !== 'object' || pluginApi === null) {
                pluginApi = {};
              }
              pluginApi[nameSymbol] = plugin;

              this.pluginApis[plugin] = pluginApi;

              cb();
            })
            .catch(err => {
              this.pluginApis[plugin] = null;

              cb(err);
            });
        })
        .catch(err => {
          this.pluginInstances[plugin] = null;
          this.pluginApis[plugin] = null;

          cb(err);
        });
    } else {
      this.pluginInstances[plugin] = null;
      this.pluginApis[plugin] = {
        [nameSymbol]: plugin,
      };

      cb();
    }
  }

  getCore() {
    return {
      express: express,
      dirname: __dirname,
      server: this.server,
      app: this.app,
      wss: this.wss,
    };
  }

  getName(moduleApi) {
    return moduleApi ? moduleApi[nameSymbol] : null;
  }

  /* broadcast(message) {
    const messageString = JSON.stringify(message);

    for (let i = 0; i < this.connections.length; i++) {
      const connection = this.connections[i];
      connection.send(messageString);
    }
  } */

  mountApp() {
    const {server, app, wss} = this;

    app.use('/', express.static(path.join(__dirname, 'public')));
    app.use('/archae/modules.json', (req, res, next) => {
      this.getClientModules((err, modules) => {
        if (!err) {
          res.json(modules);
        } else {
          res.status(500);
          res.send(err.stack);
        }
      });
    });
    app.use('/archae/engines', express.static(path.join(__dirname, 'engines', 'build')));
    app.use('/archae/plugins', express.static(path.join(__dirname, 'plugins', 'build')));
    server.on('request', app);

    wss.on('connection', c => {
      const {url} = c.upgradeReq;
      if (url === '/archae/ws') {
        console.log('connection open');

        this.connections.push(c);

        c.on('message', s => {
          const m = JSON.parse(s);

          const cb = err => {
            console.warn(err);
          };

          if (typeof m === 'object' && m && typeof m.method === 'string' && ('args' in m) && typeof m.id === 'string') {
            const cb = (err = null, result = null) => {
              if (c.readyState === ws.OPEN) {
                const e = {
                  id: m.id,
                  error: err ? (err.stack || err) : null,
                  result: result,
                };
                const es = JSON.stringify(e);
                c.send(es);
              }
            };

            const {method, args} = m;
            if (method === 'requestEngine') {
              const {engine} = args;

              if (_isValidModule(engine)) {
                this.requestEngine(engine)
                  .then(engineApi => {
                    const engineName = this.getName(engineApi);
                    cb(null, {
                      engineName,
                    });
                  })
                  .catch(err => {
                    cb(err);
                  });
              } else {
                const err = new Error('invalid engine spec');
                cb(err);
              }
            } else if (method === 'removeEngine') {
              const {engine} = args;

              if (_isValidModule(engine)) {
                this.removeEngine(engine)
                  .then(() => {
                    cb();
                  })
                  .catch(err => {
                    cb(err);
                  });
              } else {
                const err = new Error('invalid engine spec');
                cb(err);
              }
            } else if (method === 'requestPlugin') {
              const {plugin} = args;

              if (_isValidModule(plugin)) {
                this.requestPlugin(plugin)
                  .then(pluginApi => {
                    const pluginName = this.getName(pluginApi);
                    cb(null, {
                      pluginName,
                    });
                  })
                  .catch(err => {
                    cb(err);
                  });
              } else {
                const err = new Error('invalid plugin spec');
                cb(err);
              }
            } else if (method === 'removePlugin') {
              const {plugin} = args;

              if (_isValidModule(plugin)) {
                this.removePlugin(engine)
                  .then(() => {
                    cb();
                  })
                  .catch(err => {
                    cb(err);
                  });
              } else {
                const err = new Error('invalid plugin spec');
                cb(err);
              }
            } else {
              const err = new Error('invalid message method: ' + JSON.stringify(method));
              cb(err);
            }
          } else {
            const err = new Error('invalid message');
            cb(err);
          }
        });
        c.on('close', () => {
          console.log('connection close');

          this.connections.splice(this.connections.indexOf(c), 1);
        });
      }
    });
  }
}

const _addModule = (module, type, cb) => {
  const _downloadModule = (module, type, cb) => {
    if (path.isAbsolute(module)) {
      const modulePackageJsonPath = _getModulePackageJsonPath(module);
      fs.readFile(modulePackageJsonPath, 'utf8', (err, s) => {
        if (!err) {
          const j = JSON.parse(s);
          const moduleName = j.name;
          const modulePath = _getModulePath(moduleName, type);

          fs.exists(modulePath, exists => {
            if (exists) {
              _yarnInstall(moduleName, type, err => {
                if (!err) {
                  cb(null, j);
                } else {
                  cb(err);
                }
              });
            } else {
              const localModulePath = path.join(__dirname, module);
              fs.copy(localModulePath, modulePath, err => {
                if (!err) {
                  _yarnInstall(moduleName, type, err => {
                    if (!err) {
                      cb(null, j);
                    } else {
                      cb(err);
                    }
                  });
                } else {
                  cb(err);
                }
              });
            }
          });
        } else {
          cb(err);

          cleanup();
        }
      });  
    } else {
      _yarnAdd(module, type, err => {
        if (!err) {
          const modulePackageJsonPath = _getModulePackageJsonPath(module, type);
          fs.readFile(modulePackageJsonPath, 'utf8', (err, s) => {
            if (!err) {
              const j = JSON.parse(s);
              cb(null, j);
            } else {
              cb(err);
            }
          });
        } else {
          cb(err);
        }
      });
    }
  };
  const _yarnAdd = (module, type, cb) => {
    _queueYarn(cleanup => {
      const yarnAdd = child_process.spawn(
        'yarn',
        [ 'add', module ],
        {
          cwd: path.join(__dirname, type),
        }
      );
      yarnAdd.stdout.pipe(process.stdout);
      yarnAdd.stderr.pipe(process.stderr);
      yarnAdd.on('exit', code => {
        if (code === 0) {
          cb();
        } else {
          const err = new Error('yarn add error: ' + code);
          cb(err);
        }

        cleanup();
      });
    });
  };
  const _yarnInstall = (module, type, cb) => {
    _queueYarn(cleanup => {
      const modulePath = _getModulePath(module, type);
      const yarnInstall = child_process.spawn(
        'yarn',
        [ 'install' ],
        {
          cwd: modulePath,
        }
      );
      yarnInstall.stdout.pipe(process.stdout);
      yarnInstall.stderr.pipe(process.stderr);
      yarnInstall.on('exit', code => {
        if (code === 0) {
          cb();
        } else {
          const err = new Error('yard install error: ' + code);
          cb(err);
        }

        cleanup();
      });
    });
  };
  const _dumpPlugin = (module, type, cb) => {
    const {name, version = '0.0.1', dependencies = {}, client = 'client.js', server = 'server.js', files} = module;

    if (_isValidModuleSpec(module)) {
      const modulePath = _getModulePath(module.name, type);

      mkdirp(modulePath, err => {
        if (!err) {
          const packageJson = {
            name,
            version,
            dependencies,
            client,
            server,
          };
          const packageJsonString = JSON.stringify(packageJson, null, 2);

          fs.writeFile(path.join(modulePath, 'package.json'), packageJsonString, 'utf8', err => {
            if (!err) {
              _yarnInstall(module.name, type, err => {
                if (!err) {
                  if (_isValidFiles(files)) {
                    const fileNames = Object.keys(files);

                    if (fileNames.length > 0) {
                      let pending = fileNames.length;
                      const pend = () => {
                        if (--pending === 0) {
                          cb();
                        }
                      };

                      for (let i = 0; i < fileNames.length; i++) {
                        const fileName = fileNames[i];
                        const fileData = files[fileName];

                        fs.writeFile(path.join(modulePath, fileName), fileData, 'utf8', pend);
                      }
                    } else {
                      cb();
                    }
                  } else {
                    cb(err);
                  }
                } else {
                  cb();
                }
              });
            } else {
              cb(err);
            }
          });
        } else {
          cb(err);
        }
      });
    } else {
      const err = new Error('invalid module declaration');
      cb(err);
    }
  };
  const _buildModule = (module, type, cb) => {
    const moduleClientPath = _getModuleClientPath(module, type);
    const moduleBuildPath = _getModuleBuildPath(module, type);

    const webpack = child_process.spawn(
      path.join(__dirname, 'node_modules', 'webpack', 'bin', 'webpack.js'),
      [ moduleClientPath, moduleBuildPath ],
      {
        cwd: __dirname,
      }
    );
    webpack.stdout.pipe(process.stdout);
    webpack.stderr.pipe(process.stderr);
    webpack.on('exit', code => {
      if (code === 0) {
        cb();
      } else {
        const err = new Error('webpack error: ' + code);
        cb(err);
      }
    });
  };

  mkdirp(path.join(__dirname, type), err => {
    if (!err) {
      const _getModuleRealName = (module, cb) => {
        if (typeof module === 'string') {
          const packageJsonPath = _getModulePackageJsonPath(module, type);

          fs.readFile(packageJsonPath, 'utf8', (err, s) => {
            if (!err) {
              const j = JSON.parse(s);
              const moduleName = j.name;
              cb(null, moduleName);
            } else {
              cb(err);
            }
          });
        } else if (_isValidModuleSpec(module)) {
          cb(null, module.name);
        } else {
          cb(null, null);
        }
      };

      _getModuleRealName(module, (err, moduleName) => {
        if (!err) {
          const modulePath = _getModulePath(moduleName, type);

          fs.exists(modulePath, exists => {
            if (!exists) {
              if (typeof module === 'string') {
                _downloadModule(module, type, (err, packageJson) => {
                  if (!err) {
                    if (packageJson.client) {
                      _buildModule(packageJson, type, err => {
                        if (!err) {
                          cb(null, {
                            moduleName,
                          });
                        } else {
                          cb(err);
                        }
                      });
                    } else {
                      cb(null, {
                        moduleName,
                      });
                    }
                  } else {
                    cb(err);
                  }
                });
              } else if (typeof module === 'object') {
                const packageJson = module;

                _dumpPlugin(packageJson, type, err => {
                  if (!err) {
                    if (packageJson.client) {
                      _buildModule(packageJson, type, err => {
                        if (!err) {
                          cb(null, {
                            moduleName,
                          });
                        } else {
                          cb(err);
                        }
                      });
                    } else {
                      cb(null, {
                        moduleName,
                      });
                    }
                  } else {
                    cb(err);
                  }
                });
              } else {
                const err = new Error('invalid module format');
                cb(err);
              }
            } else {
              cb(null, {
                moduleName,
              });
            }
          });
        } else {
          cb(err);
        }
      });
    } else {
      cb(err);
    }
  });
};

const _removeModule = (module, type, cb) => {
  if (typeof module === 'string') {
    const modulePath = _getModulePath(module, type); // XXX fix package json removal here

    rimraf(modulePath, err => {
      if (!err) {
        const moduleBuildPath = _getModuleBuildPath(module, type);

        rimraf(moduleBuildPath, cb);
      } else {
        cb(err);
      }
    });
  } else if (typeof module ==='object') {
    if (module && typeof module.name === 'string') {
      const moduleBuildPath = _getModuleBuildPath(module.name);

      rimraf(moduleBuildPath, cb);
    } else {
      const err = new Error('invalid module declaration');
      cb(err);
    }
  } else {
    const err = new Error('invalid module format');
    cb(err);
  }
};

const _queueYarn = (() => {
  let running = false;
  const queue = [];

  const _next = handler => {
    if (!running) {
      running = true;

      handler(() => {
        running = false;

        if (queue.length > 0) {
          _next(queue.pop());
        }
      });
    } else {
      queue.push(handler);
    }
  };

  return _next;
})();

const _getModuleName = module => {
  if (typeof module === 'string') {
    return module;
  } else if (_isValidModuleSpec(module)) {
    return module.name;
  } else {
    return null;
  }
};
const _getModulePath = (module, type) => path.join(__dirname, type, 'node_modules', _getModuleName(module));
const _getModulePackageJsonPath = (module, type) => {
  const moduleName = _getModuleName(module);

  if (path.isAbsolute(moduleName)) {
    return path.join(__dirname, moduleName, 'package.json');
  } else {
    return path.join(_getModulePath(moduleName, type), 'package.json');
  }
};
const _getModuleClientPath = (module, type) => {
  const modulePath = _getModulePath(module, type);

  if (typeof module === 'string') {
    return modulePath;
  } else if (_isValidModuleSpec(module)) {
    const clientFileName = module.client;
    return path.join(modulePath, clientFileName);
  } else {
    return null;
  }
};
const _getModuleBuildPath = (module, type) => path.join(__dirname, type, 'build', _getModuleName(module) + '.js');

const _isValidModule = module => typeof module === 'string' || _isValidModuleSpec(module);
const _isValidModuleSpec = module => {
  const {name, version = '', dependencies = {}, client = '', server = ''} = module;

  return typeof name === 'string' &&
    typeof version === 'string' &&
    typeof client === 'string' &&
    typeof server === 'string' &&
    _isValidDependencies(dependencies);
};
const _isValidDependencies = dependencies => {
  if (dependencies && typeof dependencies === 'object' && !Array.isArray(dependencies)) {
    for (const k in dependencies) {
      const v = dependencies[k];
      if (typeof v !== 'string') {
        return false;
      }
    }
    return true;
  } else {
    return false;
  }
};

const _isValidFiles = files => {
  if (files && typeof files === 'object' && !Array.isArray(files)) {
    for (const k in files) {
      const v = files[k];
      if (typeof v !== 'string') {
        return false;
      }
    }
    return true;
  } else {
    return false;
  }
};

const archae = (opts) => new ArchaeServer(opts);

module.exports = archae;
