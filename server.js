/*
 * @license
 * Copyright (c) 2014 The Polymer Project Authors. All rights reserved.
 * This code may only be used under the BSD style license found at http://polymer.github.io/LICENSE.txt
 * The complete set of authors may be found at http://polymer.github.io/AUTHORS.txt
 * The complete set of contributors may be found at http://polymer.github.io/CONTRIBUTORS.txt
 * Code distributed by Google as part of the polymer project is also
 * subject to an additional IP rights grant found at http://polymer.github.io/PATENTS.txt
 */
'use strict';

var chalk        = require('chalk');
var express      = require('express');
var Firebase     = require('firebase');
var GHWebHooks   = require('github-webhook-handler');
var GitHub       = require('github');
var http         = require('http');
var path         = require('path');
var sauceConnect = require('sauce-connect-launcher');
var uuid         = require('uuid');

var Commit       = require('./lib/commit');
var Config       = require('./lib/config');
var Log          = require('./lib/log');
var protect      = require('./lib/protect');
var Queue        = require('./lib/queue');
var RepoRegistry = require('./lib/reporegistry');
var TestRunner   = require('./lib/testrunner');

// Setup

// We may not be in a real TTY, but we _really_ like colors.
chalk.enabled = true;

// We open a crap ton of concurrent requests to Sauce.
http.globalAgent.maxSockets = 250;

var config = new Config(process.env);

var fbRoot = new Firebase(config.firebase.root);
fbRoot.auth(config.firebase.secret);

var github = new GitHub({version: '3.0.0'});
github.authenticate({type: 'oauth', token: config.github.oauthToken});

var repos = new RepoRegistry(path.join(__dirname, 'commits'));
var app   = express();
var hooks = new GHWebHooks({path: config.github.webhookPath, secret: config.github.webhookSecret});

// Sauce Tunnel

console.log('Establishing Sauce tunnel');

config.sauce.tunnelIdentifier = uuid.v4();
sauceConnect(config.sauce, function(error, tunnel) {
  if (error) throw error;
  console.log('Sauce tunnel established. Tunnel id:', config.sauce.tunnelIdentifier);

  // Commit Processor (Depends on Sauce)

  var queue = new Queue(processor, fbRoot.child('queue'), config);
  function processor(commit, done) {
    // TODO(nevir): synchronize status output too!
    var fbStatus = fbRoot.child('status').child(commit.key);
    var log      = new Log(process.stdout, commit, fbStatus.child('log'));
    var runner   = new TestRunner(commit, fbStatus, github, repos, config, log);
    protect(function() {
      runner.run(done);
    }, function(error) {
      log.fatal(error, 'CI runner internal error:');
      runner.setCommitStatus('error', 'Internal Error');
      done(error);
    });
  }

  // Web Server

  console.log('server starting');

  app.use(function(req, res, next){
    console.log('%s %s', req.method, req.url);
    next();
  });

  app.use(hooks);

  app.get('/', function(req, res) {
    res.send('CI Runner: https://github.com/PolymerLabs/ci-runner');
  });

  hooks.on('push', function(event) {
    console.log('Received GitHub push event');

    var payload = event.payload;
    var commit;
    try {
      commit = Commit.forPushEvent(payload);
    } catch (error) {
      console.log('Malformed push event:', error, '\n', payload);
      return;
    }

    if (VALID_PUSH_BRANCHES.indexOf(commit.branch) === -1) {
      console.log('Push branch not in whitelist:', commit.branch);
    } else {
      queue.add(commit);
    }
  });

  hooks.on('pull_request', function(event) {
    console.log('Received GitHub pull_request event');

    var payload = event.payload;
    var commit;
    try {
      commit = Commit.forPullRequestEvent(payload);
    } catch (error) {
      console.log('Malformed push event:', error, '\n', payload);
      return;
    }
    queue.add(commit);
  });

  app.listen(config.worker.port);

  console.log('server listening for requests');
});
