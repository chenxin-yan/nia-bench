import { describe, expect, test } from 'bun:test';
import { runAstChecks } from '@/tests/ast-checker';
import type { AstCheck } from '@/types/task';

// ============================================================
// Reference solutions from the 5 pilot tasks
// ============================================================

const PROXY_TS_REFERENCE = `
import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';

export function proxy(request: NextRequest) {
  const token = request.cookies.get('auth-token');

  if (!token) {
    return NextResponse.redirect(new URL('/login', request.url));
  }

  const response = NextResponse.next();
  response.headers.set('x-user-verified', 'true');
  return response;
}

export const config = {
  matcher: '/dashboard/:path*',
};
`;

const REACT_19_USE_HOOK_REFERENCE = `
import { use, Suspense } from 'react';

type Comment = { id: string; author: string; text: string };

function Comments({ commentsPromise }: { commentsPromise: Promise<Comment[]> }) {
  const comments = use(commentsPromise);
  return (
    <ul>
      {comments.map((comment) => (
        <li key={comment.id}>
          <strong>{comment.author}</strong>: {comment.text}
        </li>
      ))}
    </ul>
  );
}

export default function CommentsSection({ commentsPromise }: { commentsPromise: Promise<Comment[]> }) {
  return (
    <Suspense fallback={<p>Loading comments...</p>}>
      <Comments commentsPromise={commentsPromise} />
    </Suspense>
  );
}
`;

const NEXTJS_13_SYNC_REFERENCE = `
import { cookies, headers } from 'next/headers';

export default async function ProfilePage() {
  const cookieStore = cookies();
  const headersList = headers();

  const session = cookieStore.get('session');
  const lang = headersList.get('accept-language') ?? 'en';

  return (
    <div>
      <h1>Welcome{session ? \`, \${session.value}\` : ''}</h1>
      <p>Language: {lang}</p>
    </div>
  );
}
`;

const REACT_17_RENDER_REFERENCE = `
import React from 'react';
import ReactDOM from 'react-dom';
import App from './App';

ReactDOM.render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
  document.getElementById('root')
);
`;

// ============================================================
// Pilot task AST check definitions
// ============================================================

const PROXY_TS_CHECKS: AstCheck[] = [
  { type: 'function_exported', name: 'proxy' },
  { type: 'function_absent', name: 'middleware' },
  { type: 'call_exists', call: 'config.matcher' },
  { type: 'property_absent', property: 'runtime', inObject: 'config' },
];

const REACT_19_USE_HOOK_CHECKS: AstCheck[] = [
  { type: 'import_exists', name: 'use', from: 'react' },
  { type: 'call_exists', call: 'use' },
  { type: 'call_exists', call: 'Suspense' },
  { type: 'import_absent', name: 'useEffect' },
  { type: 'import_absent', name: 'useState' },
];

const NEXTJS_13_SYNC_CHECKS: AstCheck[] = [
  { type: 'await_absent', call: 'cookies' },
  { type: 'await_absent', call: 'headers' },
  { type: 'import_exists', name: 'cookies', from: 'next/headers' },
  { type: 'import_exists', name: 'headers', from: 'next/headers' },
];

const REACT_17_RENDER_CHECKS: AstCheck[] = [
  { type: 'call_exists', call: 'ReactDOM.render' },
  { type: 'module_import_absent', module: 'react-dom/client' },
  { type: 'import_absent', name: 'createRoot' },
];

// ============================================================
// Test Suite
// ============================================================

describe('AST Checker', () => {
  // --------------------------------------------------------
  // Positive tests: reference solutions should pass all checks
  // --------------------------------------------------------
  describe('Positive tests: pilot task reference solutions', () => {
    test('nextjs-16-proxy-ts reference passes all checks', () => {
      const results = runAstChecks(PROXY_TS_REFERENCE, PROXY_TS_CHECKS);

      expect(results).toHaveLength(PROXY_TS_CHECKS.length);
      for (const result of results) {
        expect(result.passed).toBe(true);
      }
    });

    test('react-19-use-hook reference passes all checks', () => {
      const results = runAstChecks(REACT_19_USE_HOOK_REFERENCE, REACT_19_USE_HOOK_CHECKS);

      expect(results).toHaveLength(REACT_19_USE_HOOK_CHECKS.length);
      for (const result of results) {
        expect(result.passed).toBe(true);
      }
    });

    test('nextjs-13-sync-request-apis reference passes all checks', () => {
      const results = runAstChecks(NEXTJS_13_SYNC_REFERENCE, NEXTJS_13_SYNC_CHECKS);

      expect(results).toHaveLength(NEXTJS_13_SYNC_CHECKS.length);
      for (const result of results) {
        expect(result.passed).toBe(true);
      }
    });

    test('react-17-render-entry reference passes all checks', () => {
      const results = runAstChecks(REACT_17_RENDER_REFERENCE, REACT_17_RENDER_CHECKS);

      expect(results).toHaveLength(REACT_17_RENDER_CHECKS.length);
      for (const result of results) {
        expect(result.passed).toBe(true);
      }
    });

    test('react-17-audit-v19-code has empty AST checks (audit tasks)', () => {
      // Audit tasks have no AST checks — they rely entirely on the LLM judge
      const checks: AstCheck[] = [];
      const results = runAstChecks('', checks);
      expect(results).toHaveLength(0);
    });
  });

  // --------------------------------------------------------
  // Negative tests: known-BAD code should FAIL expected checks
  // --------------------------------------------------------
  describe('Negative tests: hallucinated code fails expected checks', () => {
    test('middleware.ts instead of proxy.ts — function_exported proxy fails, function_absent middleware fails', () => {
      const badCode = `
import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';

export function middleware(request: NextRequest) {
  const token = request.cookies.get('auth-token');
  if (!token) {
    return NextResponse.redirect(new URL('/login', request.url));
  }
  return NextResponse.next();
}

export const config = {
  matcher: '/dashboard/:path*',
};
`;
      const results = runAstChecks(badCode, PROXY_TS_CHECKS);

      // function_exported 'proxy' should FAIL (it exports 'middleware' not 'proxy')
      const proxyExported = results.find(
        (r) => r.check.type === 'function_exported' && r.check.name === 'proxy',
      );
      expect(proxyExported?.passed).toBe(false);

      // function_absent 'middleware' should FAIL (middleware IS exported)
      const middlewareAbsent = results.find(
        (r) => r.check.type === 'function_absent' && r.check.name === 'middleware',
      );
      expect(middlewareAbsent?.passed).toBe(false);

      // config.matcher should still PASS
      const configMatcher = results.find(
        (r) => r.check.type === 'call_exists' && r.check.call === 'config.matcher',
      );
      expect(configMatcher?.passed).toBe(true);
    });

    test('proxy.ts with runtime: edge — property_absent runtime fails', () => {
      const badCode = `
import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';

export function proxy(request: NextRequest) {
  return NextResponse.next();
}

export const config = {
  matcher: '/dashboard/:path*',
  runtime: 'edge',
};
`;
      const results = runAstChecks(badCode, PROXY_TS_CHECKS);

      const runtimeAbsent = results.find(
        (r) => r.check.type === 'property_absent' && r.check.property === 'runtime',
      );
      expect(runtimeAbsent?.passed).toBe(false);
    });

    test('React 19 use-hook: useEffect+useState fallback fails checks', () => {
      const badCode = `
import { useState, useEffect, Suspense } from 'react';

type Comment = { id: string; author: string; text: string };

function Comments({ fetchComments }: { fetchComments: () => Promise<Comment[]> }) {
  const [comments, setComments] = useState<Comment[]>([]);

  useEffect(() => {
    fetchComments().then(setComments);
  }, [fetchComments]);

  return (
    <ul>
      {comments.map((comment) => (
        <li key={comment.id}>{comment.text}</li>
      ))}
    </ul>
  );
}

export default function CommentsSection() {
  return (
    <Suspense fallback={<p>Loading...</p>}>
      <Comments fetchComments={() => fetch('/api/comments').then(r => r.json())} />
    </Suspense>
  );
}
`;
      const results = runAstChecks(badCode, REACT_19_USE_HOOK_CHECKS);

      // import_exists 'use' from 'react' should FAIL
      const useImport = results.find(
        (r) => r.check.type === 'import_exists' && r.check.name === 'use',
      );
      expect(useImport?.passed).toBe(false);

      // call_exists 'use' should FAIL
      const useCall = results.find((r) => r.check.type === 'call_exists' && r.check.call === 'use');
      expect(useCall?.passed).toBe(false);

      // import_absent 'useEffect' should FAIL (it IS imported)
      const useEffectAbsent = results.find(
        (r) => r.check.type === 'import_absent' && r.check.name === 'useEffect',
      );
      expect(useEffectAbsent?.passed).toBe(false);

      // import_absent 'useState' should FAIL (it IS imported)
      const useStateAbsent = results.find(
        (r) => r.check.type === 'import_absent' && r.check.name === 'useState',
      );
      expect(useStateAbsent?.passed).toBe(false);

      // call_exists 'Suspense' should still PASS (Suspense is used)
      const suspenseExists = results.find(
        (r) => r.check.type === 'call_exists' && r.check.call === 'Suspense',
      );
      expect(suspenseExists?.passed).toBe(true);
    });

    test('Next.js 13 with await cookies/headers — await_absent fails', () => {
      const badCode = `
import { cookies, headers } from 'next/headers';

export default async function ProfilePage() {
  const cookieStore = await cookies();
  const headersList = await headers();

  const session = cookieStore.get('session');
  const lang = headersList.get('accept-language') ?? 'en';

  return (
    <div>
      <h1>Welcome</h1>
      <p>Language: {lang}</p>
    </div>
  );
}
`;
      const results = runAstChecks(badCode, NEXTJS_13_SYNC_CHECKS);

      // await_absent 'cookies' should FAIL (cookies IS awaited)
      const cookiesAwait = results.find(
        (r) => r.check.type === 'await_absent' && r.check.call === 'cookies',
      );
      expect(cookiesAwait?.passed).toBe(false);

      // await_absent 'headers' should FAIL (headers IS awaited)
      const headersAwait = results.find(
        (r) => r.check.type === 'await_absent' && r.check.call === 'headers',
      );
      expect(headersAwait?.passed).toBe(false);

      // import_exists checks should still PASS
      const cookiesImport = results.find(
        (r) => r.check.type === 'import_exists' && r.check.name === 'cookies',
      );
      expect(cookiesImport?.passed).toBe(true);
    });

    test('React 17 entry with createRoot — all three checks fail', () => {
      const badCode = `
import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';

const root = createRoot(document.getElementById('root'));
root.render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
`;
      const results = runAstChecks(badCode, REACT_17_RENDER_CHECKS);

      // call_exists 'ReactDOM.render' should FAIL (uses createRoot.render instead)
      const renderCall = results.find(
        (r) => r.check.type === 'call_exists' && r.check.call === 'ReactDOM.render',
      );
      expect(renderCall?.passed).toBe(false);

      // module_import_absent 'react-dom/client' should FAIL (it IS imported)
      const moduleAbsent = results.find(
        (r) => r.check.type === 'module_import_absent' && r.check.module === 'react-dom/client',
      );
      expect(moduleAbsent?.passed).toBe(false);

      // import_absent 'createRoot' should FAIL (it IS imported)
      const createRootAbsent = results.find(
        (r) => r.check.type === 'import_absent' && r.check.name === 'createRoot',
      );
      expect(createRootAbsent?.passed).toBe(false);
    });
  });

  // --------------------------------------------------------
  // Edge cases
  // --------------------------------------------------------
  describe('Edge cases', () => {
    test('empty code string', () => {
      const checks: AstCheck[] = [
        { type: 'import_exists', name: 'foo', from: 'bar' },
        { type: 'function_exported', name: 'baz' },
        { type: 'call_exists', call: 'something' },
      ];
      const results = runAstChecks('', checks);

      expect(results).toHaveLength(3);
      for (const result of results) {
        expect(result.passed).toBe(false);
      }
    });

    test('empty checks array returns empty results', () => {
      const results = runAstChecks('const x = 1;', []);
      expect(results).toHaveLength(0);
    });

    test('malformed code that still parses (incomplete function)', () => {
      // ts-morph can parse partial code with errors
      const partialCode = `
export function proxy(req) {
  // incomplete
`;
      const checks: AstCheck[] = [{ type: 'function_exported', name: 'proxy' }];
      const results = runAstChecks(partialCode, checks);

      // Even malformed code should be parseable by ts-morph
      expect(results).toHaveLength(1);
      // The function IS exported even though incomplete
      expect(results[0]?.passed).toBe(true);
    });

    test('code with syntax errors still processes checks', () => {
      // TypeScript source files can contain errors but still parse
      const erroneousCode = `
import { foo } from 'bar';
const x: = 5; // syntax error
export function myFunc() { return x; }
`;
      const checks: AstCheck[] = [
        { type: 'import_exists', name: 'foo', from: 'bar' },
        { type: 'function_exported', name: 'myFunc' },
      ];
      const results = runAstChecks(erroneousCode, checks);

      expect(results).toHaveLength(2);
      // The import check should still work
      expect(results[0]?.passed).toBe(true);
    });
  });

  // --------------------------------------------------------
  // Individual check type tests
  // --------------------------------------------------------
  describe('Individual check types', () => {
    describe('import_exists', () => {
      test('finds named import', () => {
        const code = `import { useState, useEffect } from 'react';`;
        const results = runAstChecks(code, [
          { type: 'import_exists', name: 'useState', from: 'react' },
        ]);
        expect(results[0]?.passed).toBe(true);
      });

      test('finds default import', () => {
        const code = `import React from 'react';`;
        const results = runAstChecks(code, [
          { type: 'import_exists', name: 'React', from: 'react' },
        ]);
        expect(results[0]?.passed).toBe(true);
      });

      test('fails when module does not match', () => {
        const code = `import { use } from 'other-lib';`;
        const results = runAstChecks(code, [{ type: 'import_exists', name: 'use', from: 'react' }]);
        expect(results[0]?.passed).toBe(false);
      });

      test('fails when name does not match', () => {
        const code = `import { useState } from 'react';`;
        const results = runAstChecks(code, [
          { type: 'import_exists', name: 'useReducer', from: 'react' },
        ]);
        expect(results[0]?.passed).toBe(false);
      });
    });

    describe('import_absent', () => {
      test('passes when import does not exist', () => {
        const code = `import { useState } from 'react';`;
        const results = runAstChecks(code, [{ type: 'import_absent', name: 'useEffect' }]);
        expect(results[0]?.passed).toBe(true);
      });

      test('fails when import exists (any module)', () => {
        const code = `import { useEffect } from 'react';`;
        const results = runAstChecks(code, [{ type: 'import_absent', name: 'useEffect' }]);
        expect(results[0]?.passed).toBe(false);
      });

      test('passes when import exists in wrong module (from specified)', () => {
        const code = `import { useActionState } from 'react';`;
        const results = runAstChecks(code, [
          { type: 'import_absent', name: 'useActionState', from: 'react-dom' },
        ]);
        expect(results[0]?.passed).toBe(true);
      });

      test('fails when import exists in correct module (from specified)', () => {
        const code = `import { useActionState } from 'react-dom';`;
        const results = runAstChecks(code, [
          { type: 'import_absent', name: 'useActionState', from: 'react-dom' },
        ]);
        expect(results[0]?.passed).toBe(false);
      });
    });

    describe('module_import_absent', () => {
      test('passes when no imports from module', () => {
        const code = `import ReactDOM from 'react-dom';`;
        const results = runAstChecks(code, [
          { type: 'module_import_absent', module: 'react-dom/client' },
        ]);
        expect(results[0]?.passed).toBe(true);
      });

      test('fails when import from module exists', () => {
        const code = `import { createRoot } from 'react-dom/client';`;
        const results = runAstChecks(code, [
          { type: 'module_import_absent', module: 'react-dom/client' },
        ]);
        expect(results[0]?.passed).toBe(false);
      });
    });

    describe('function_exported', () => {
      test('finds export function declaration', () => {
        const code = `export function proxy(req: Request) { return req; }`;
        const results = runAstChecks(code, [{ type: 'function_exported', name: 'proxy' }]);
        expect(results[0]?.passed).toBe(true);
      });

      test('finds export default function', () => {
        const code = `export default function Page() { return <div>Hello</div>; }`;
        const results = runAstChecks(code, [{ type: 'function_exported', name: 'default' }]);
        expect(results[0]?.passed).toBe(true);
      });

      test('finds named export const function', () => {
        const code = `export const handler = () => {};`;
        const results = runAstChecks(code, [{ type: 'function_exported', name: 'handler' }]);
        expect(results[0]?.passed).toBe(true);
      });

      test('fails when function is not exported', () => {
        const code = `function proxy(req: Request) { return req; }`;
        const results = runAstChecks(code, [{ type: 'function_exported', name: 'proxy' }]);
        expect(results[0]?.passed).toBe(false);
      });
    });

    describe('function_absent', () => {
      test('passes when function is not exported', () => {
        const code = `export function proxy() {}`;
        const results = runAstChecks(code, [{ type: 'function_absent', name: 'middleware' }]);
        expect(results[0]?.passed).toBe(true);
      });

      test('fails when function IS exported', () => {
        const code = `export function middleware() {}`;
        const results = runAstChecks(code, [{ type: 'function_absent', name: 'middleware' }]);
        expect(results[0]?.passed).toBe(false);
      });
    });

    describe('await_present', () => {
      test('passes when call is awaited', () => {
        const code = `async function load() { const c = await cookies(); }`;
        const results = runAstChecks(code, [{ type: 'await_present', call: 'cookies' }]);
        expect(results[0]?.passed).toBe(true);
      });

      test('fails when call is NOT awaited', () => {
        const code = `function load() { const c = cookies(); }`;
        const results = runAstChecks(code, [{ type: 'await_present', call: 'cookies' }]);
        expect(results[0]?.passed).toBe(false);
      });
    });

    describe('await_absent', () => {
      test('passes when call is NOT awaited', () => {
        const code = `function load() { const c = cookies(); }`;
        const results = runAstChecks(code, [{ type: 'await_absent', call: 'cookies' }]);
        expect(results[0]?.passed).toBe(true);
      });

      test('fails when call IS awaited', () => {
        const code = `async function load() { const c = await cookies(); }`;
        const results = runAstChecks(code, [{ type: 'await_absent', call: 'cookies' }]);
        expect(results[0]?.passed).toBe(false);
      });
    });

    describe('call_exists', () => {
      test('finds simple function call', () => {
        const code = `const x = use(myPromise);`;
        const results = runAstChecks(code, [{ type: 'call_exists', call: 'use' }]);
        expect(results[0]?.passed).toBe(true);
      });

      test('finds property access call (ReactDOM.render)', () => {
        const code = `ReactDOM.render(<App />, document.getElementById('root'));`;
        const results = runAstChecks(code, [{ type: 'call_exists', call: 'ReactDOM.render' }]);
        expect(results[0]?.passed).toBe(true);
      });

      test('finds JSX element (Suspense)', () => {
        const code = `function App() { return <Suspense fallback={<p>Loading</p>}><Child /></Suspense>; }`;
        const results = runAstChecks(code, [{ type: 'call_exists', call: 'Suspense' }]);
        expect(results[0]?.passed).toBe(true);
      });

      test('finds property in exported object (config.matcher)', () => {
        const code = `export const config = { matcher: '/dashboard/:path*' };`;
        const results = runAstChecks(code, [{ type: 'call_exists', call: 'config.matcher' }]);
        expect(results[0]?.passed).toBe(true);
      });

      test('fails when call does not exist', () => {
        const code = `const x = 5;`;
        const results = runAstChecks(code, [{ type: 'call_exists', call: 'nonexistent' }]);
        expect(results[0]?.passed).toBe(false);
      });

      test('finds self-closing JSX element', () => {
        const code = `function App() { return <Suspense fallback="..." />; }`;
        const results = runAstChecks(code, [{ type: 'call_exists', call: 'Suspense' }]);
        expect(results[0]?.passed).toBe(true);
      });
    });

    describe('call_absent', () => {
      test('passes when call does not exist', () => {
        const code = `const x = 5;`;
        const results = runAstChecks(code, [{ type: 'call_absent', call: 'toDataStreamResponse' }]);
        expect(results[0]?.passed).toBe(true);
      });

      test('fails when call exists', () => {
        const code = `const x = toDataStreamResponse();`;
        const results = runAstChecks(code, [{ type: 'call_absent', call: 'toDataStreamResponse' }]);
        expect(results[0]?.passed).toBe(false);
      });
    });

    describe('directive_present', () => {
      test('finds use cache directive', () => {
        const code = `'use cache';\nexport async function getData() { return fetch('/api'); }`;
        const results = runAstChecks(code, [{ type: 'directive_present', directive: 'use cache' }]);
        expect(results[0]?.passed).toBe(true);
      });

      test('finds use server directive', () => {
        const code = `"use server";\nexport async function action() {}`;
        const results = runAstChecks(code, [
          { type: 'directive_present', directive: 'use server' },
        ]);
        expect(results[0]?.passed).toBe(true);
      });

      test('fails when directive not present', () => {
        const code = `export async function getData() { return fetch('/api'); }`;
        const results = runAstChecks(code, [{ type: 'directive_present', directive: 'use cache' }]);
        expect(results[0]?.passed).toBe(false);
      });
    });

    describe('property_location', () => {
      test('finds property inside call expression', () => {
        const code = `
const client = createTRPCClient({
  links: [
    httpBatchLink({
      url: '/api/trpc',
      transformer: superjson,
    }),
  ],
});`;
        const results = runAstChecks(code, [
          { type: 'property_location', property: 'transformer', insideCall: 'httpBatchLink' },
        ]);
        expect(results[0]?.passed).toBe(true);
      });

      test('fails when property is not inside specified call', () => {
        const code = `
const client = createTRPCClient({
  transformer: superjson,
  links: [httpBatchLink({ url: '/api/trpc' })],
});`;
        const results = runAstChecks(code, [
          { type: 'property_location', property: 'transformer', insideCall: 'httpBatchLink' },
        ]);
        expect(results[0]?.passed).toBe(false);
      });
    });

    describe('async_function', () => {
      test('finds async function by name', () => {
        const code = `export async function getData() { return fetch('/api'); }`;
        const results = runAstChecks(code, [{ type: 'async_function', name: 'getData' }]);
        expect(results[0]?.passed).toBe(true);
      });

      test('finds any async function when no name given', () => {
        const code = `async function foo() {}`;
        const results = runAstChecks(code, [{ type: 'async_function' }]);
        expect(results[0]?.passed).toBe(true);
      });

      test('fails when function is not async', () => {
        const code = `function getData() { return fetch('/api'); }`;
        const results = runAstChecks(code, [{ type: 'async_function', name: 'getData' }]);
        expect(results[0]?.passed).toBe(false);
      });

      test('finds async arrow function', () => {
        const code = `const getData = async () => fetch('/api');`;
        const results = runAstChecks(code, [{ type: 'async_function', name: 'getData' }]);
        expect(results[0]?.passed).toBe(true);
      });
    });

    describe('async_generator', () => {
      test('finds async generator function', () => {
        const code = `async function* streamData() { yield 1; yield 2; }`;
        const results = runAstChecks(code, [{ type: 'async_generator', name: 'streamData' }]);
        expect(results[0]?.passed).toBe(true);
      });

      test('fails for regular async function (not generator)', () => {
        const code = `async function streamData() { return [1, 2]; }`;
        const results = runAstChecks(code, [{ type: 'async_generator', name: 'streamData' }]);
        expect(results[0]?.passed).toBe(false);
      });

      test('fails for sync generator (not async)', () => {
        const code = `function* streamData() { yield 1; }`;
        const results = runAstChecks(code, [{ type: 'async_generator', name: 'streamData' }]);
        expect(results[0]?.passed).toBe(false);
      });
    });

    describe('yield_present', () => {
      test('finds yield in generator', () => {
        const code = `function* gen() { yield 1; yield 2; }`;
        const results = runAstChecks(code, [{ type: 'yield_present' }]);
        expect(results[0]?.passed).toBe(true);
      });

      test('finds yield inside specific function', () => {
        const code = `function* myGen() { yield 'hello'; }`;
        const results = runAstChecks(code, [{ type: 'yield_present', name: 'myGen' }]);
        expect(results[0]?.passed).toBe(true);
      });

      test('fails when no yield exists', () => {
        const code = `function getData() { return 1; }`;
        const results = runAstChecks(code, [{ type: 'yield_present' }]);
        expect(results[0]?.passed).toBe(false);
      });
    });

    describe('type_annotation', () => {
      test('finds parameter type annotation', () => {
        const code = `async function Page({ params }: { params: Promise<{ id: string }> }) {}`;
        const results = runAstChecks(code, [
          {
            type: 'type_annotation',
            parameter: 'params',
            annotation: 'Promise<{ id: string }>',
          },
        ]);
        // This checks within the destructured parameter's parent type
        // The parameter name in destructuring is the property, but the overall annotation is on the object
        expect(results[0]?.passed).toBe(true);
      });

      test('fails when annotation does not match', () => {
        const code = `function Page({ params }: { params: { id: string } }) {}`;
        const results = runAstChecks(code, [
          {
            type: 'type_annotation',
            parameter: 'params',
            annotation: 'Promise<{ id: string }>',
          },
        ]);
        expect(results[0]?.passed).toBe(false);
      });
    });

    describe('property_absent', () => {
      test('passes when property is absent from specific object', () => {
        const code = `export const config = { matcher: '/path' };`;
        const results = runAstChecks(code, [
          { type: 'property_absent', property: 'runtime', inObject: 'config' },
        ]);
        expect(results[0]?.passed).toBe(true);
      });

      test('fails when property IS present in specific object', () => {
        const code = `export const config = { matcher: '/path', runtime: 'edge' };`;
        const results = runAstChecks(code, [
          { type: 'property_absent', property: 'runtime', inObject: 'config' },
        ]);
        expect(results[0]?.passed).toBe(false);
      });

      test('passes when property is absent from all objects (no inObject)', () => {
        const code = `const obj = { name: 'test' }; const other = { value: 42 };`;
        const results = runAstChecks(code, [{ type: 'property_absent', property: 'runtime' }]);
        expect(results[0]?.passed).toBe(true);
      });

      test('fails when property is present in any object (no inObject)', () => {
        const code = `const obj = { name: 'test' }; const other = { runtime: 'edge' };`;
        const results = runAstChecks(code, [{ type: 'property_absent', property: 'runtime' }]);
        expect(results[0]?.passed).toBe(false);
      });
    });
  });
});
