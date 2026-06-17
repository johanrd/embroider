import { appScenarios } from './scenarios';
import { throwOnWarnings } from '@embroider/core';
import merge from 'lodash/merge';
import { setupAuditTest } from '@embroider/test-support/audit-assertions';
import QUnit from 'qunit';
import CommandWatcher from './helpers/command-watcher';
import fetch from 'node-fetch';

const { module: Qmodule, test } = QUnit;

// A code-split route named "map" gets a route entrypoint whose virtual id ends
// in ".map" (`-embroider-route-entrypoint.js:route=parent.map`). Vite's dev
// sourcemap middleware (Vite 8) intercepts any ".map"-suffixed request and
// never serves it as JavaScript, so the route's chunk can't be loaded.
//
// We reproduce this entirely over HTTP against `vite dev` — no browser. The
// audit starts from index.html and fetches every reachable module through the
// dev server, so the route entrypoint goes through the same sourcemap
// middleware a browser would hit. Before the fix that fetch is hijacked and the
// module is missing/unparseable; after it, it's served as JS and parses.
appScenarios
  .map('route-name-map', app => {
    // The Vite sourcemap middleware that mishandles ".map" ids is in Vite 8.
    app.linkDevDependency('vite', { resolveName: 'vite-8', baseDir: __dirname });

    merge(app.files, {
      'ember-cli-build.js': `
        'use strict';
        const EmberApp = require('ember-cli/lib/broccoli/ember-app');
        const { maybeEmbroider } = require('@embroider/test-setup');
        module.exports = function (defaults) {
          let app = new EmberApp(defaults, {});
          return maybeEmbroider(app, {
            staticInvokables: true,
            splitAtRoutes: ['parent', 'parent.map'],
          });
        };
      `,
      app: {
        'router.js': `
          import EmberRouter from '@embroider/router';
          import config from 'app-template/config/environment';
          export default class Router extends EmberRouter {
            location = config.locationType;
            rootURL = config.rootURL;
          }
          Router.map(function () {
            this.route('parent', function () {
              this.route('map');
            });
          });
        `,
        routes: {
          parent: {
            'map.js': `import Route from '@ember/routing/route'; export default class MapRoute extends Route {}`,
          },
        },
        templates: {
          'parent.hbs': `{{outlet}}`,
          parent: {
            'map.hbs': `<div data-test-map>map route loaded</div>`,
          },
        },
      },
    });
  })
  .forEachScenario(scenario => {
    Qmodule(scenario.name, function (hooks) {
      throwOnWarnings(hooks);

      let server: CommandWatcher;
      let appURL: string;

      hooks.before(async () => {
        let app = await scenario.prepare();
        server = CommandWatcher.launch('vite', ['--clearScreen', 'false'], { cwd: app.dir });
        [, appURL] = await server.waitFor(/Local:\s+(https?:\/\/.*)\//g);
      });

      hooks.after(async () => {
        await server?.shutdown();
      });

      let expectAudit = setupAuditTest(hooks, () => ({
        appURL,
        startingFrom: ['index.html'],
        fetch: fetch as unknown as typeof globalThis.fetch,
      }));

      test('route entrypoint for a split route named "map" is served as JS by vite dev', function () {
        // If the ".map" id were hijacked by the sourcemap middleware, this
        // module would be missing or unparseable rather than valid JS.
        expectAudit
          .module(/-embroider-route-entrypoint\.js:route=parent\.map/)
          .withContents(() => true, 'route entrypoint for "map" route loaded as a JS module');
      });
    });
  });
