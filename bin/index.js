#!/usr/bin/env node
require("dotenv").config();
var pull = require("pull-stream");
var debug = require("debug");
var log = debug("pando-computing");
var logMonitoring = debug("pando-computing:monitoring");
var logMonitoringChildren = debug("pando-computing:monitoring:children");
var logHeartbeat = debug("pando-computing:heartbeat");
var electronWebRTC = require("electron-webrtc");
var createProcessor = require("../src/processor.js");
var Node = require("webrtc-tree-overlay");
var Server = require("pando-server");
var BootstrapClient = require("webrtc-bootstrap");
var os = require("os");
var fs = require("fs");
var path = require("path");
var website = require("simple-updatable-website");
var probe = require("pull-probe");
var mkdirp = require("mkdirp");
var sync = require("pull-sync");
var limit = require("pull-limit");
var duplexWs = require("pull-ws");
var express = require("express");
var http = require("http");
var WebSocket = require("ws");

function getIPAddresses() {
  var ifaces = os.networkInterfaces();
  var addresses = [];

  Object.keys(ifaces).forEach(function (ifname) {
    var alias = 0;

    ifaces[ifname].forEach(function (iface) {
      if (iface.family !== "IPv4" || iface.internal !== false) {
        // skip over internal (i.e. 127.0.0.1) and non-ipv4 addresses
        return;
      }

      if (alias >= 1) {
        // this single interface has multiple ipv4 addresses
        addresses.push(iface.address);
      } else {
        // this interface has only one ipv4 adress
        addresses.push(iface.address);
      }
    });
  });
  return addresses;
}

var wrtc = electronWebRTC({ headless: process.env.HEADLESS || false });
class Project {
  constructor({
    port,
    // module,
    items = [],
    secret = "INSECURE-SECRET",
    seed = null,
    heartbeat = 30000,
    batchSize = 1,
    degree = 10,
    globalMonitoring = false,
    iceServers = ["stun:stun.l.google.com:19302"],
    reportingInterval = 3,
    bootstrapTimeout = 60,
    syncStdio = false,
    projectID,
  }) {
    this.port = port;
    this.server = null;
    this.processor = null;
    this.host = null;
    this.wsVolunteersStatus = {};
    this.statusSocket = null;
    this.secret = secret;
    this.seed = seed;
    this.heartbeat = heartbeat;
    this.batchSize = batchSize;
    this.degree = degree;
    this.globalMonitoring = globalMonitoring;
    this.iceServers = iceServers.map((url) => ({ urls: url }));
    this.reportingInterval = reportingInterval;
    this.bootstrapTimeout = bootstrapTimeout;
    this.startIdle = true;
    this.items = pull.values(items.map((x) => String(x)));
    this.syncStdio = syncStdio;
    this.id = projectID;
  }

  start() {
    const _this = this;

    log("creating bootstrap server");
    var publicDir = path.join(__dirname, "../local-server/public");
    // var publicDir = path.join(__dirname, "../testLocal");
    mkdirp.sync(publicDir);
    this.server = new Server({
      secret: this.secret,
      publicDir: publicDir,
      port: this.port,
      seed: this.seed,
    });
    this.host = "localhost:" + this.port;

    this.server._bootstrap.upgrade("/volunteer", (ws) => {
      if (this.processor) {
        log("volunteer connected over WebSocket");

        ws.isAlive = true;
        var heartbeat = setInterval(function ping() {
          if (ws.isAlive === false) {
            logHeartbeat("ws: volunteer connection lost");
            return ws.terminate();
          }
          ws.isAlive = false;
          ws.ping(function () {});
        }, this.heartbeat);
        ws.addEventListener("close", function () {
          clearInterval(heartbeat);
          heartbeat = null;
        });
        ws.addEventListener("error", function () {
          clearInterval(heartbeat);
          heartbeat = null;
        });
        ws.addEventListener("pong", function () {
          logHeartbeat("ws: volunteer connection pong");
          ws.isAlive = true;
        });

        this.processor.lendStream(function (err, stream) {
          if (err) return log("error lender sub-stream to volunteer: " + err);
          log("lending sub-stream to volunteer");

          pull(
            stream,
            probe("volunteer-input"),
            limit(duplexWs(ws), _this.batchSize),
            probe("volunteer-output"),
            stream
          );
        });
      }
    });

    this.server._bootstrap.upgrade("/volunteer-monitoring", (ws) => {
      log("volunteer monitoring connected over WebSocket");

      ws.isAlive = true;
      var heartbeat = setInterval(function ping() {
        if (ws.isAlive === false) {
          logHeartbeat("ws: volunteer monitoring connection lost");
          return ws.terminate();
        }
        ws.isAlive = false;
        ws.ping(function () {});
      }, this.heartbeat);
      ws.addEventListener("close", function () {
        clearInterval(heartbeat);
        heartbeat = null;
      });
      ws.addEventListener("error", function () {
        clearInterval(heartbeat);
        heartbeat = null;
      });
      ws.addEventListener("pong", function () {
        logHeartbeat("ws: volunteer monitoring pong");
        ws.isAlive = true;
      });

      let id = null;

      pull(
        duplexWs.source(ws),
        pull.drain(
          function (data) {
            let info = JSON.parse(data);
            id = info.userId;
            let time = new Date();

            _this.wsVolunteersStatus[id] = {
              id,
              ...info,
            };
            // console.log(_this.wsVolunteersStatus);
            delete _this.wsVolunteersStatus[undefined];
            _this.reportProjectStatus(
              JSON.stringify(_this.wsVolunteersStatus),
              _this.id
            );

            let lastReportTime = time;
          },
          function () {
            if (id) {
              delete _this.wsVolunteersStatus[id];
            }
          }
        )
      );
    });

    getIPAddresses().forEach((addr) => {
      console.error(
        "Serving volunteer code at http://" + addr + ":" + this.port
      );
    });

    log("Serializing configuration for workers");
    fs.writeFileSync(
      path.join(__dirname, "../public/config.js"),
      "window.pando = { config: " +
        JSON.stringify({
          batchSize: this.batchSize,
          degree: this.degree,
          globalMonitoring: this.globalMonitoring,
          iceServers: this.iceServers,
          reportingInterval: this.reportingInterval * 1000,
          requestTimeoutInMs: this.bootstrapTimeout * 1000,
          version: "1.0.0",
        }) +
        " }"
    );

    log("Uploading files to " + this.host + " with secret " + this.secret);
    website.upload(
      [
        // bundlePath,
        path.join(__dirname, "../src/parse.js"),
        path.join(__dirname, "../public/config.js"),
        path.join(__dirname, "../public/index.html"),
        path.join(__dirname, "../public/volunteer.js"),
        path.join(__dirname, "../public/simplewebsocket.min.js"),
        path.join(
          __dirname,
          "../node_modules/bootstrap/dist/css/bootstrap.min.css"
        ),
        path.join(
          __dirname,
          "../node_modules/bootstrap/dist/js/bootstrap.min.js"
        ),
        path.join(__dirname, "../node_modules/jquery/jquery.min.js"),
        path.join(
          __dirname,
          "../node_modules/popper.js/dist/umd/popper.min.js"
        ),
      ],
      this.host,
      this.secret,
      (err) => {
        if (err) throw err;
        log("files uploaded successfully");

        log("connecting to bootstrap server");
        var bootstrap = new BootstrapClient(this.host);

        log("creating root node");
        var root = new Node(bootstrap, {
          requestTimeoutInMs: this.bootstrapTimeout * 1000, // ms
          peerOpts: {
            wrtc: wrtc,
            config: { iceServers: this.iceServers },
          },
          maxDegree: this.degree,
        }).becomeRoot(this.secret);

        this.processor = createProcessor(root, {
          batchSize: this.batchSize,
          bundle: !this.startIdle
            ? require(bundlePath)["/pando/1.0.0"]
            : function (x, cb) {
                console.error(
                  "Internal error, bundle should not have been executed"
                );
              },
          globalMonitoring: this.globalMonitoring,
          reportingInterval: this.reportingInterval * 1000, // ms
          startProcessing: !this.startIdle,
        });

        const close = () => {
          log("closing");
          if (this.server) {
            this.server.close();
            _this.reportProjectStatus("error", _this.id);
          }
          if (root) root.close();
          if (bootstrap) bootstrap.close();
          if (wrtc) wrtc.close();
          if (this.processor) this.processor.close();
        };

        var io = {
          source: this.items,
          sink: pull.drain(
            function (x) {
              x = JSON.parse(x);
              _this.addOutput(_this.id, x.output, x.userId, x.totalOutput);
            },
            function (err) {
              log("drain:done(" + err + ")");
              if (err) {
                console.error(err.message);
                console.error(err);
                close();
              } else {
                console.log(`${_this.id} is done`);
                close();
              }
            }
          ),
        };

        if (this.syncStdio) {
          io = sync(io);
        }

        pull(
          io,
          pull.through(log),
          probe("pando:input"),
          this.processor,
          probe("pando:result"),
          pull.through(log),
          io
        );
      }
    );
  }

  close() {
    if (this.server) {
      this.server.close();
    }
    if (wrtc) wrtc.close();
    if (this.processor) this.processor.close();
  }
}

Project.prototype.addOutput = function (bucketId, value, user, totalOutput) {
  process.stdout.write(String(value) + "\n");
};

Project.prototype.reportProjectStatus = function (data, bucketId) {
  // process.stdout.write((data) + "\n");
};

module.exports = {
  getIPAddresses,
  Project,
};
