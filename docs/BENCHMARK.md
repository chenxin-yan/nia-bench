# Nia-Bench: Version-Aware Code Generation Benchmark

> Evaluating how context-augmentation tools improve coding agents' accuracy across library versions

## 1. Overview

**Nia-Bench** is an open-source benchmark that measures how well context-augmentation tools help coding agents generate **version-correct** code when working with real-world JavaScript/TypeScript libraries.

It tests a fundamental challenge: LLMs have knowledge cutoffs and can hallucinate APIs that don't exist, use deprecated patterns, or mix features from different library versions. Context tools like **Nia** and **Context7** aim to solve this by providing agents with up-to-date, version-specific documentation and source code.

### Core Thesis

Context tools should help agents write correct code not just for _bleeding-edge_ features (released after training cutoff), but also for _specific legacy versions_ — avoiding both hallucinated new APIs and deprecated old ones.

| Condition    | Description                                                                                         |
| ------------ | --------------------------------------------------------------------------------------------------- |
| **Baseline** | Claude Sonnet 4 with no external context tools. Relies purely on training data.                     |
| **Context7** | Claude Sonnet 4 + Context7 MCP server (`resolve-library-id` -> `query-docs`).                       |
| **Nia**      | Claude Sonnet 4 + Nia skills (full toolset: `search`, `nia_read`, `nia_grep`, `nia_explore`, etc.). |

## 2. Target Libraries

All libraries are from the JavaScript/TypeScript ecosystem, chosen for their rich version histories with significant breaking changes between versions.

| Library           | Versions Under Test | Key Breaking Changes                                                                                           |
| ----------------- | ------------------- | -------------------------------------------------------------------------------------------------------------- |
| **Next.js**       | 13, 14, 15, 16      | `middleware.ts`->`proxy.ts`, enforced async APIs, Turbopack default, cache components, removed AMP/`next lint` |
| **React**         | 17, 18, 19          | Concurrent features, `use()`, `useActionState`, `ref` as prop, removed `ReactDOM.render`                       |
| **Vercel AI SDK** | 3, 4, 5             | `experimental_` prefix removal, DataStream->UIMessageStream (SSE), sync vs async                               |
| **tRPC**          | 10, 11              | Transformer location, React Query v5, renamed exports, SSE subscriptions                                       |
| **Zod**           | 3, 4                | Error API overhaul, string validators to top-level, `z.record()` requires 2 args, `z.function()` redesign      |

---

## 3. Task Design

### 3.1 Task Categories

The benchmark includes **40 tasks** split across three categories:

#### Category A: Bleeding-Edge API Tasks (14 tasks)

Tasks requiring features from the **latest** version of each library — features likely released after the LLM's training cutoff. The agent must use the correct, current API without inventing methods or using outdated patterns.

#### Category B1: Version-Locked Write Tasks (14 tasks)

Tasks where the agent is explicitly told the project uses a **specific older version** and must write code that **only uses APIs valid for that version**. Using APIs from newer versions should be penalized.

#### Category B2: Version-Locked Audit Tasks (12 tasks)

Tasks where the agent is given code and must **identify APIs that are invalid, deprecated, or version-incorrect** for the specified version, then suggest correct alternatives _for that version_.

---

### 3.2 Task Schema

Each task is defined as a JSON object:

```jsonc
{
  "id": "nextjs-16-proxy-ts",
  "category": "bleeding_edge", // "bleeding_edge" | "version_locked_write" | "version_locked_audit"
  "library": "next", // "next" | "react" | "ai" | "trpc" | "zod"
  "target_version": "16.0.0", // exact version the task targets
  "prompt": "...", // the prompt given to the agent
  "context": {}, // optional: provided codebase/package.json for version-locked tasks
  "reference_solution": "...", // canonical correct code
  "test_spec": {}, // automated test configuration
  "rubric": {}, // LLM judge evaluation criteria
  "common_hallucinations": [], // known failure modes for validation
}
```

---

## 4. Complete Task Inventory

### 4.1 Category A: Bleeding-Edge API Tasks

#### Next.js 16 (3 tasks)

---

**Task A-NX-1: `proxy.ts` (Middleware Rename)**

- **ID:** `nextjs-16-proxy-ts`
- **Prompt:**
  > Using Next.js 16, create a proxy file that handles authentication. It should check for an `auth-token` cookie on all routes under `/dashboard`. If the token is missing, redirect to `/login`. If the token exists, add a custom `x-user-verified` header to the request.
- **What it tests:** In Next.js 16, `middleware.ts` was renamed to `proxy.ts` and the exported function was renamed from `middleware()` to `proxy()`. The runtime is now Node.js only (not Edge). This is the most visible breaking change and LLMs will overwhelmingly generate `middleware.ts` with `export function middleware()`.
- **Reference solution:**

  ```typescript
  // proxy.ts (at project root or src/)
  import { NextResponse } from "next/server";
  import type { NextRequest } from "next/server";

  export function proxy(request: NextRequest) {
    const token = request.cookies.get("auth-token");

    if (!token) {
      return NextResponse.redirect(new URL("/login", request.url));
    }

    const response = NextResponse.next();
    response.headers.set("x-user-verified", "true");
    return response;
  }

  export const config = {
    matcher: "/dashboard/:path*",
  };
  ```

- **Test spec:**
  - AST: file is named `proxy.ts` (not `middleware.ts`)
  - AST: exports a function named `proxy` (not `middleware`)
  - AST: does NOT export a function named `middleware`
  - AST: `config.matcher` is present for route matching
  - AST: does NOT set `runtime: 'edge'` in config (Node.js only in v16)
- **Common hallucinations:**
  - Creating `middleware.ts` instead of `proxy.ts` (v15 and earlier pattern)
  - `export function middleware(request: NextRequest)` (v15 function name)
  - Setting `runtime: 'edge'` in config (not supported in `proxy.ts`)
  - Using Express-style middleware patterns
- **Rubric:**
  | Criterion | Weight | Description |
  | --- | --- | --- |
  | `proxy_filename` | 25% | File is `proxy.ts`, not `middleware.ts` |
  | `proxy_function_name` | 25% | Exports `function proxy()`, not `function middleware()` |
  | `no_edge_runtime` | 15% | Does not set `runtime: 'edge'` in config |
  | `correct_api_usage` | 20% | Correctly uses `NextResponse`, `NextRequest`, cookies, redirects |
  | `no_hallucination` | 15% | No v15 middleware patterns, no invented APIs |

---

**Task A-NX-2: Enforced Async Request APIs + Parallel Route Defaults**

- **ID:** `nextjs-16-enforced-async`
- **Prompt:**
  > Using Next.js 16, create an App Router page at `app/dashboard/[id]/page.tsx` that reads the `id` param, the `tab` search parameter, and the user's session from cookies. Also this app uses a parallel route `@modal` — create the required `app/@modal/default.tsx` file. Use the correct Next.js 16 async APIs.
- **What it tests:** Next.js 16 enforces async request APIs with no synchronous fallback (v15 still had a temporary sync fallback). Also tests the new requirement that parallel route slots must have explicit `default.js` files. LLMs trained on v13/14 will use sync access; those trained on v15 may still try sync fallback.
- **Reference solution:**

  ```typescript
  // app/dashboard/[id]/page.tsx
  import { cookies } from 'next/headers';

  export default async function DashboardPage({
    params,
    searchParams,
  }: {
    params: Promise<{ id: string }>;
    searchParams: Promise<{ tab?: string }>;
  }) {
    const { id } = await params;
    const { tab } = await searchParams;
    const cookieStore = await cookies();
    const session = cookieStore.get('session');

    return (
      <div>
        <h1>Dashboard {id}</h1>
        <p>Tab: {tab ?? 'overview'}</p>
        <p>Session: {session?.value ?? 'none'}</p>
      </div>
    );
  }

  // app/@modal/default.tsx
  export default function ModalDefault() {
    return null;
  }
  ```

- **Test spec:**
  - AST: `params` is awaited before accessing `.id`
  - AST: `searchParams` is awaited before accessing `.tab`
  - AST: `cookies()` is awaited
  - AST: params is typed as `Promise<{ id: string }>`
  - AST: `app/@modal/default.tsx` exists and exports a default component
  - AST: component function is `async`
- **Common hallucinations:**
  - `const { id } = params` (v13/14 sync destructuring)
  - `const cookieStore = cookies()` (v13/14 sync call)
  - Omitting the `app/@modal/default.tsx` file (required in v16)
  - Typing params as `{ id: string }` instead of `Promise<{ id: string }>`
- **Rubric:**
  | Criterion | Weight | Description |
  | --- | --- | --- |
  | `async_params` | 20% | `params` is awaited |
  | `async_search_params` | 20% | `searchParams` is awaited |
  | `async_cookies` | 15% | `cookies()` is awaited |
  | `promise_types` | 15% | Types use `Promise<>` wrapper |
  | `parallel_route_default` | 15% | `@modal/default.tsx` is created |
  | `no_hallucination` | 15% | No sync access patterns from v13/14/15 |

---

**Task A-NX-3: Cache Components (`"use cache"` Directive)**

- **ID:** `nextjs-16-cache-components`
- **Prompt:**
  > Using Next.js 16, create a blog post page component that uses the new `"use cache"` directive for caching. The component should fetch a blog post by slug from a database and use `cacheTag()` for tag-based revalidation and `cacheLife('hours')` for time-based caching. Also create a Server Action that revalidates the post using `updateTag()` (the new read-your-writes cache invalidation API).
- **What it tests:** Next.js 16 introduced stable `"use cache"` directive, `cacheTag()`, `cacheLife()` (without `unstable_` prefix), and the new `updateTag()` function for read-your-writes cache invalidation. LLMs will not know about these.
- **Reference solution:**

  ```typescript
  // app/blog/[slug]/page.tsx
  'use cache';

  import { cacheLife, cacheTag } from 'next/cache';

  cacheLife('hours');
  cacheTag('blog-posts');

  export default async function BlogPost({
    params,
  }: {
    params: Promise<{ slug: string }>;
  }) {
    const { slug } = await params;
    const post = await db.posts.findBySlug(slug);

    cacheTag(`post-${slug}`);

    return (
      <article>
        <h1>{post.title}</h1>
        <p>{post.content}</p>
      </article>
    );
  }

  // app/blog/[slug]/actions.ts
  'use server';

  import { updateTag } from 'next/cache';

  export async function refreshPost(slug: string) {
    await db.posts.touch(slug);
    updateTag(`post-${slug}`);
  }
  ```

- **Test spec:**
  - AST: file-level `'use cache'` directive is present
  - AST: imports `cacheLife`, `cacheTag` from `next/cache`
  - AST: calls `cacheLife('hours')` (not `unstable_cacheLife`)
  - AST: calls `cacheTag(...)` (not `unstable_cacheTag`)
  - AST: imports `updateTag` from `next/cache` (not `revalidateTag` for read-your-writes)
  - AST: does NOT use `unstable_` prefix on any cache function
- **Common hallucinations:**
  - Using `unstable_cacheLife` or `unstable_cacheTag` (v15 experimental names)
  - Using `revalidateTag()` instead of `updateTag()` for immediate invalidation
  - Not including the `'use cache'` directive
  - Using `fetch()` with `{ next: { revalidate: 3600 } }` instead of the new caching API
  - Inventing a `cache()` wrapper function
- **Rubric:**
  | Criterion | Weight | Description |
  | --- | --- | --- |
  | `use_cache_directive` | 20% | `'use cache'` directive is present at file or function level |
  | `cache_life` | 20% | Uses `cacheLife()` without `unstable_` prefix |
  | `cache_tag` | 20% | Uses `cacheTag()` without `unstable_` prefix |
  | `update_tag` | 20% | Uses `updateTag()` for read-your-writes invalidation |
  | `no_hallucination` | 20% | No `unstable_` prefixes, no invented cache APIs |

---

#### React 19 (3 tasks)

---

**Task A-RX-1: `use()` Hook**

- **ID:** `react-19-use-hook`
- **Prompt:**
  > Using React 19, create a `Comments` component that receives a `commentsPromise` prop (a Promise that resolves to an array of comments). Use the `use()` hook to read the promise value. Wrap the component in Suspense in the parent. Each comment has `id`, `author`, and `text` fields.
- **What it tests:** The `use()` hook is entirely new in React 19 — it can read promises and context, and unlike other hooks, can be called conditionally. LLMs will not know about it.
- **Reference solution:**

  ```tsx
  import { use, Suspense } from "react";

  type Comment = { id: string; author: string; text: string };

  function Comments({
    commentsPromise,
  }: {
    commentsPromise: Promise<Comment[]>;
  }) {
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

  export default function CommentsSection({
    commentsPromise,
  }: {
    commentsPromise: Promise<Comment[]>;
  }) {
    return (
      <Suspense fallback={<p>Loading comments...</p>}>
        <Comments commentsPromise={commentsPromise} />
      </Suspense>
    );
  }
  ```

- **Test spec:**
  - AST: imports `use` from `react`
  - AST: calls `use(commentsPromise)` or `use(props.commentsPromise)`
  - AST: `Suspense` wraps the component that uses `use()`
  - AST: does NOT use `useEffect` + `useState` for data fetching
- **Common hallucinations:**
  - Using `useEffect` + `useState` pattern (React 17/18 approach)
  - Inventing `useSuspense()` or `usePromise()` hooks
  - Using `React.lazy()` instead of `use()`
- **Rubric:**
  | Criterion | Weight | Description |
  | --- | --- | --- |
  | `use_hook_import` | 20% | Imports `use` from `react` |
  | `use_hook_call` | 30% | Calls `use()` with the promise prop |
  | `suspense_boundary` | 20% | Wraps component in `<Suspense>` |
  | `no_useeffect_pattern` | 15% | Does not fall back to useEffect+useState |
  | `no_hallucination` | 15% | No invented hooks |

---

**Task A-RX-2: `useActionState` + `useFormStatus`**

- **ID:** `react-19-form-actions`
- **Prompt:**
  > Using React 19, create a login form component that uses `useActionState` for form submission handling and `useFormStatus` for a submit button that shows loading state. The action should validate email and password and return `{ error: string | null }`. Use Server Actions with the `'use server'` directive.
- **What it tests:** `useActionState` (renamed from `useFormState`) and `useFormStatus` are React 19 hooks. LLMs may hallucinate `useFormState` from react-dom or invent patterns.
- **Reference solution:**

  ```tsx
  "use client";

  import { useActionState } from "react";
  import { useFormStatus } from "react-dom";
  import { loginAction } from "./actions";

  function SubmitButton() {
    const { pending } = useFormStatus();
    return (
      <button type="submit" disabled={pending}>
        {pending ? "Signing in..." : "Sign In"}
      </button>
    );
  }

  export default function LoginForm() {
    const [state, formAction, isPending] = useActionState(loginAction, {
      error: null,
    });

    return (
      <form action={formAction}>
        <input name="email" type="email" required />
        <input name="password" type="password" required />
        <SubmitButton />
        {state.error && <p>{state.error}</p>}
      </form>
    );
  }

  // actions.ts
  // 'use server';
  // export async function loginAction(prevState: { error: string | null }, formData: FormData) {
  //   const email = formData.get('email') as string;
  //   const password = formData.get('password') as string;
  //   if (!email || !password) return { error: 'All fields required' };
  //   // ... authenticate
  //   return { error: null };
  // }
  ```

- **Test spec:**
  - AST: imports `useActionState` from `react` (NOT `react-dom`)
  - AST: imports `useFormStatus` from `react-dom`
  - AST: does NOT import `useFormState`
  - AST: `useActionState` returns 3 values (state, action, isPending)
  - AST: `useFormStatus` is called in a child component, not the form component itself
- **Common hallucinations:**
  - Using `useFormState` (the old canary name) from `react-dom`
  - Importing `useActionState` from `react-dom` instead of `react`
  - Using `useFormStatus` in the same component as the form (must be a child)
  - Only destructuring 2 values from `useActionState` (missing `isPending`)
- **Rubric:**
  | Criterion | Weight | Description |
  | --- | --- | --- |
  | `useActionState_import` | 20% | Imports `useActionState` from `react` |
  | `useFormStatus_import` | 15% | Imports `useFormStatus` from `react-dom` |
  | `not_useFormState` | 15% | Does NOT use the deprecated `useFormState` name |
  | `three_return_values` | 15% | Destructures `[state, formAction, isPending]` |
  | `child_component` | 15% | `useFormStatus` is in a child component of the form |
  | `no_hallucination` | 20% | No invented patterns |

---

**Task A-RX-3: `ref` as Prop (No `forwardRef`)**

- **ID:** `react-19-ref-as-prop`
- **Prompt:**
  > Using React 19, create a reusable `TextInput` component that accepts a `ref` prop to expose the underlying `<input>` element. Do NOT use `forwardRef` — React 19 supports `ref` as a regular prop. Then create a parent component that focuses the input on a button click.
- **What it tests:** React 19 deprecated `forwardRef` and now supports `ref` as a normal prop. LLMs trained on v17/18 will always use `forwardRef`.
- **Reference solution:**

  ```tsx
  import { useRef } from "react";

  function TextInput({
    placeholder,
    ref,
  }: {
    placeholder?: string;
    ref?: React.Ref<HTMLInputElement>;
  }) {
    return <input ref={ref} placeholder={placeholder} />;
  }

  export default function SearchBar() {
    const inputRef = useRef<HTMLInputElement>(null);

    return (
      <div>
        <TextInput ref={inputRef} placeholder="Search..." />
        <button onClick={() => inputRef.current?.focus()}>Focus Input</button>
      </div>
    );
  }
  ```

- **Test spec:**
  - AST: `TextInput` accepts `ref` in its props destructuring
  - AST: does NOT use `forwardRef`
  - AST: does NOT import `forwardRef` from `react`
  - AST: parent passes `ref` to `TextInput` like any other prop
- **Common hallucinations:**
  - Using `React.forwardRef()` wrapper (v17/18 pattern)
  - Using `forwardRef<HTMLInputElement, Props>` generic
  - Claiming `ref` can't be passed as a regular prop
- **Rubric:**
  | Criterion | Weight | Description |
  | --- | --- | --- |
  | `ref_as_prop` | 30% | `ref` is in the component's regular props |
  | `no_forward_ref` | 30% | Does not use `forwardRef` |
  | `correct_typing` | 20% | `ref` is typed as `React.Ref<HTMLInputElement>` or similar |
  | `no_hallucination` | 20% | No invented patterns |

---

#### Vercel AI SDK 5 (3 tasks)

---

**Task A-AI-1: UIMessageStream (SSE Protocol)**

- **ID:** `ai-sdk-5-ui-message-stream`
- **Prompt:**
  > Using Vercel AI SDK v5, create a Next.js Route Handler at `app/api/chat/route.ts` that streams a chat response using the new `createUIMessageStream` and `createUIMessageStreamResponse` APIs with the SSE protocol. Use `openai('gpt-4o')` as the model. The handler should receive messages from the request body.
- **What it tests:** AI SDK v5 replaced the proprietary DataStream protocol with standard Server-Sent Events (SSE) via `createUIMessageStream`/`createUIMessageStreamResponse`. v3/v4 users will use `toDataStreamResponse()` or `toAIStreamResponse()`.
- **Reference solution:**

  ```typescript
  import {
    createUIMessageStream,
    createUIMessageStreamResponse,
    streamText,
    generateId,
  } from "ai";
  import { openai } from "@ai-sdk/openai";

  export async function POST(req: Request) {
    const { messages } = await req.json();

    const stream = createUIMessageStream({
      originalMessages: messages,
      generateId,
      execute: ({ writer }) => {
        const result = streamText({
          model: openai("gpt-4o"),
          messages,
        });

        writer.merge(result.toUIMessageStream());
      },
    });

    return createUIMessageStreamResponse(stream);
  }
  ```

- **Test spec:**
  - AST: imports `createUIMessageStream` from `ai`
  - AST: imports `createUIMessageStreamResponse` from `ai`
  - AST: does NOT import `createDataStreamResponse`
  - AST: does NOT call `toDataStreamResponse()` or `toAIStreamResponse()`
  - AST: calls `writer.merge()` inside the execute callback
  - AST: calls `result.toUIMessageStream()` (not `toDataStream()`)
- **Common hallucinations:**
  - Using `toDataStreamResponse()` (v4 pattern)
  - Using `toAIStreamResponse()` (v3 pattern)
  - Using `StreamingTextResponse` (very old v3 pattern)
  - Not passing `originalMessages` and `generateId` to `createUIMessageStream`
- **Rubric:**
  | Criterion | Weight | Description |
  | --- | --- | --- |
  | `ui_message_stream` | 25% | Uses `createUIMessageStream` |
  | `ui_message_response` | 20% | Uses `createUIMessageStreamResponse` |
  | `writer_merge` | 20% | Uses `writer.merge(result.toUIMessageStream())` pattern |
  | `no_data_stream` | 15% | Does NOT use DataStream or AIStream APIs |
  | `correct_params` | 10% | Passes `originalMessages` and `generateId` |
  | `no_hallucination` | 10% | No invented APIs |

---

**Task A-AI-2: Data Parts with Transient State**

- **ID:** `ai-sdk-5-data-parts`
- **Prompt:**
  > Using Vercel AI SDK v5, create a Route Handler that streams a chat response and includes transient "loading status" data parts that update during streaming. The status should show "thinking..." initially, update to "generating..." during streaming, and "complete" when done. Use `writer.write()` for data parts and `writer.merge()` for the main stream.
- **What it tests:** v5's data parts model with reconciliation and transient data. This feature has no equivalent in v3/v4.
- **Reference solution:**

  ```typescript
  import {
    createUIMessageStream,
    createUIMessageStreamResponse,
    streamText,
    generateId,
  } from "ai";
  import { openai } from "@ai-sdk/openai";

  export async function POST(req: Request) {
    const { messages } = await req.json();

    const stream = createUIMessageStream({
      originalMessages: messages,
      generateId,
      execute: ({ writer }) => {
        const statusId = generateId();

        writer.write({
          type: "data",
          id: statusId,
          data: { status: "thinking..." },
          transient: true,
        });

        const result = streamText({
          model: openai("gpt-4o"),
          messages,
          onChunk() {
            writer.write({
              type: "data",
              id: statusId,
              data: { status: "generating..." },
              transient: true,
            });
          },
          onFinish() {
            writer.write({
              type: "data",
              id: statusId,
              data: { status: "complete" },
            });
          },
        });

        writer.merge(result.toUIMessageStream());
      },
    });

    return createUIMessageStreamResponse(stream);
  }
  ```

- **Test spec:**
  - AST: uses `writer.write()` with objects containing `transient: true`
  - AST: uses consistent `id` across write calls for reconciliation
  - AST: does NOT use `dataStream.writeData()` (v4 pattern)
  - AST: uses `onChunk` and `onFinish` callbacks
- **Common hallucinations:**
  - Using `dataStream.writeData()` (v4)
  - Using `StreamData` class (v3/v4)
  - Not using `transient` flag for loading states
  - Not using consistent IDs for reconciliation
- **Rubric:**
  | Criterion | Weight | Description |
  | --- | --- | --- |
  | `writer_write` | 25% | Uses `writer.write()` for data parts |
  | `transient_flag` | 25% | Uses `transient: true` for loading states |
  | `id_reconciliation` | 20% | Same ID used across status updates |
  | `no_v4_api` | 15% | No `writeData()` or `StreamData` |
  | `no_hallucination` | 15% | No invented APIs |

---

**Task A-AI-3: No `await` on `streamText`**

- **ID:** `ai-sdk-4-sync-stream-text`
- **Prompt:**
  > Using Vercel AI SDK v4, create a Next.js Route Handler that uses `streamText` to stream a response. The handler should process chat messages and return the response as a data stream. Use `openai('gpt-4o')` as the model.
- **What it tests:** In AI SDK v4+, `streamText` is synchronous (no `await`). LLMs trained on v3 will add `await`. Also tests correct response method (`toDataStreamResponse` not `toAIStreamResponse`).
- **Reference solution:**

  ```typescript
  import { streamText } from "ai";
  import { openai } from "@ai-sdk/openai";

  export async function POST(req: Request) {
    const { messages } = await req.json();

    const result = streamText({
      model: openai("gpt-4o"),
      messages,
    });

    return result.toDataStreamResponse();
  }
  ```

- **Test spec:**
  - AST: `streamText()` is NOT inside an `await` expression
  - AST: calls `toDataStreamResponse()` (not `toAIStreamResponse`)
  - AST: does NOT import `experimental_streamText`
  - AST: imports `streamText` from `ai`
- **Common hallucinations:**
  - `const result = await streamText(...)` (v3 async pattern)
  - `result.toAIStreamResponse()` (v3 method name)
  - `import { experimental_streamText } from 'ai'` (v3 experimental prefix)
  - Using `StreamingTextResponse` wrapper (very old v3)
- **Rubric:**
  | Criterion | Weight | Description |
  | --- | --- | --- |
  | `no_await` | 30% | `streamText` is called without `await` |
  | `correct_response_method` | 25% | Uses `toDataStreamResponse()` |
  | `no_experimental_prefix` | 20% | Does not use `experimental_` prefix |
  | `correct_import` | 15% | Imports from `ai`, not old paths |
  | `no_hallucination` | 10% | No invented APIs |

---

#### tRPC 11 (3 tasks)

---

**Task A-TR-1: Transformer in Link Config**

- **ID:** `trpc-11-transformer-link`
- **Prompt:**
  > Using tRPC v11 with Next.js App Router, set up the tRPC client configuration. Use `superjson` as the data transformer and `httpBatchLink` as the link. The tRPC API endpoint is at `/api/trpc`.
- **What it tests:** In tRPC v11, the `transformer` config moved from the client-level to the link-level. This is the most common migration mistake. Also tests that `createTRPCClient` replaced `createTRPCProxyClient`.
- **Reference solution:**

  ```typescript
  import { createTRPCClient, httpBatchLink } from "@trpc/client";
  import superjson from "superjson";
  import type { AppRouter } from "@/server/routers/_app";

  export const trpc = createTRPCClient<AppRouter>({
    links: [
      httpBatchLink({
        url: "/api/trpc",
        transformer: superjson,
      }),
    ],
  });
  ```

- **Test spec:**
  - AST: `transformer` is inside `httpBatchLink({})` options, NOT at `createTRPCClient({})` level
  - AST: uses `createTRPCClient` (not `createTRPCProxyClient`)
  - AST: imports `createTRPCClient` from `@trpc/client`
- **Common hallucinations:**
  - `createTRPCClient({ transformer: superjson, links: [...] })` (v10 location)
  - Using `createTRPCProxyClient` (v10 name, renamed in v11)
  - Putting transformer at both levels
- **Rubric:**
  | Criterion | Weight | Description |
  | --- | --- | --- |
  | `transformer_in_link` | 35% | `transformer` is inside `httpBatchLink()` config |
  | `correct_client_fn` | 25% | Uses `createTRPCClient`, not `createTRPCProxyClient` |
  | `correct_import` | 20% | Imports from `@trpc/client` |
  | `no_hallucination` | 20% | No invented APIs |

---

**Task A-TR-2: SSE Subscriptions**

- **ID:** `trpc-11-sse-subscriptions`
- **Prompt:**
  > Using tRPC v11, create a subscription procedure that streams real-time stock price updates using Server-Sent Events (not WebSockets). Create both the server-side procedure using an async generator and the client-side `httpSubscriptionLink` setup.
- **What it tests:** tRPC v11 introduced SSE-based subscriptions via `httpSubscriptionLink` as an alternative to WebSockets. This uses async generators server-side.
- **Reference solution:**

  ```typescript
  // server/routers/stocks.ts
  import { initTRPC } from "@trpc/server";
  import { z } from "zod";

  const t = initTRPC.create();

  export const stockRouter = t.router({
    onPriceUpdate: t.procedure
      .input(z.object({ symbol: z.string() }))
      .subscription(async function* ({ input }) {
        while (true) {
          const price = await getStockPrice(input.symbol);
          yield { symbol: input.symbol, price, timestamp: Date.now() };
          await new Promise((resolve) => setTimeout(resolve, 1000));
        }
      }),
  });

  // client setup
  import {
    createTRPCClient,
    httpSubscriptionLink,
    httpBatchLink,
    splitLink,
  } from "@trpc/client";

  const client = createTRPCClient<AppRouter>({
    links: [
      splitLink({
        condition: (op) => op.type === "subscription",
        true: httpSubscriptionLink({ url: "/api/trpc" }),
        false: httpBatchLink({ url: "/api/trpc" }),
      }),
    ],
  });
  ```

- **Test spec:**
  - AST: subscription uses `async function*` (async generator)
  - AST: imports `httpSubscriptionLink` from `@trpc/client`
  - AST: uses `splitLink` to route subscriptions
  - AST: does NOT import `wsLink` (WebSocket link)
- **Common hallucinations:**
  - Using `wsLink` for subscriptions (v10 pattern)
  - Using Observable-based subscriptions (v10 pattern)
  - Inventing a `sseLink` that doesn't exist
- **Rubric:**
  | Criterion | Weight | Description |
  | --- | --- | --- |
  | `async_generator` | 25% | Server uses `async function*` for subscription |
  | `http_subscription_link` | 25% | Client uses `httpSubscriptionLink` |
  | `split_link` | 20% | Uses `splitLink` to separate subscription traffic |
  | `no_ws_link` | 15% | Does not use WebSocket link |
  | `no_hallucination` | 15% | No invented APIs |

---

**Task A-TR-3: Shorthand Router + Streaming Query**

- **ID:** `trpc-11-shorthand-streaming`
- **Prompt:**
  > Using tRPC v11, create a router that uses shorthand router definitions (plain objects instead of explicit `router()` calls) and includes a query that returns a streaming iterable using an async generator. Create a `posts` namespace with a `list` procedure that streams posts one by one.
- **What it tests:** Two v11 features: shorthand router (plain objects as sub-routers) and streaming queries via async generators.
- **Reference solution:**

  ```typescript
  import { initTRPC } from "@trpc/server";

  const t = initTRPC.create();

  export const appRouter = t.router({
    posts: {
      list: t.procedure.query(async function* () {
        const posts = await fetchAllPosts();
        for (const post of posts) {
          yield post;
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
      }),
    },
  });
  ```

- **Test spec:**
  - AST: `posts` key maps to a plain object (not a `t.router()` call)
  - AST: `.query()` uses an `async function*` (async generator)
  - AST: uses `yield` keyword inside the query
- **Common hallucinations:**
  - Wrapping nested routes in `t.router()` (unnecessary in v11)
  - Returning an array instead of streaming
  - Using `Observable` from rxjs (v10 subscription pattern)
- **Rubric:**
  | Criterion | Weight | Description |
  | --- | --- | --- |
  | `shorthand_router` | 30% | Nested routes use plain object, not `t.router()` |
  | `async_generator_query` | 30% | Query uses `async function*` |
  | `yield_keyword` | 20% | Uses `yield` to stream results |
  | `no_hallucination` | 20% | No invented patterns |

---

#### Zod 4 (2 tasks)

---

**Task A-ZD-1: Top-Level String Format Validators**

- **ID:** `zod-4-top-level-validators`
- **Prompt:**
  > Using Zod v4, create a schema for a user registration form that validates: email (valid email format), website (valid URL), user ID (valid UUID), and IP address (valid IPv4). Use the new v4 top-level format validators.
- **What it tests:** Zod v4 moved string format validators from `z.string().email()` to `z.email()` as top-level functions. Also, `z.string().ip()` was removed and replaced by `z.ipv4()` / `z.ipv6()`.
- **Reference solution:**

  ```typescript
  import { z } from "zod";

  const registrationSchema = z.object({
    email: z.email(),
    website: z.url(),
    userId: z.uuid(),
    ipAddress: z.ipv4(),
  });

  type Registration = z.infer<typeof registrationSchema>;
  ```

- **Test spec:**
  - AST: calls `z.email()` (not `z.string().email()`)
  - AST: calls `z.url()` (not `z.string().url()`)
  - AST: calls `z.uuid()` (not `z.string().uuid()`)
  - AST: calls `z.ipv4()` (not `z.string().ip()`)
  - AST: does NOT call `z.string().ip()` (removed in v4)
- **Common hallucinations:**
  - `z.string().email()` (v3 chained pattern — deprecated in v4)
  - `z.string().ip()` (removed in v4, no longer exists)
  - `z.string().ip({ version: "v4" })` (v3 pattern, removed)
- **Rubric:**
  | Criterion | Weight | Description |
  | --- | --- | --- |
  | `top_level_email` | 20% | Uses `z.email()` |
  | `top_level_url` | 20% | Uses `z.url()` |
  | `top_level_uuid` | 20% | Uses `z.uuid()` |
  | `ipv4_not_ip` | 25% | Uses `z.ipv4()`, not `z.string().ip()` |
  | `no_hallucination` | 15% | No invented APIs |

---

**Task A-ZD-2: Error Customization API**

- **ID:** `zod-4-error-api`
- **Prompt:**
  > Using Zod v4, create a string schema for a username field that: requires minimum 3 characters, maximum 20 characters, and provides custom error messages for different failure cases (field required vs invalid type vs too short/long). Use the new v4 error customization API.
- **What it tests:** Zod v4 completely overhauled error customization: `message` -> `error`, removed `invalid_type_error` and `required_error`, replaced `errorMap` with a function-based `error` param.
- **Reference solution:**

  ```typescript
  import { z } from "zod";

  const usernameSchema = z
    .string({
      error: (issue) => {
        if (issue.input === undefined) return "Username is required";
        return "Username must be a string";
      },
    })
    .min(3, { error: "Username must be at least 3 characters" })
    .max(20, { error: "Username must be at most 20 characters" });
  ```

- **Test spec:**
  - AST: uses `error` parameter (not `message`)
  - AST: does NOT use `invalid_type_error` property
  - AST: does NOT use `required_error` property
  - AST: does NOT use `errorMap` property
  - AST: the schema-level `error` is a function (not a string) for differentiated messages
- **Common hallucinations:**
  - `z.string({ required_error: "...", invalid_type_error: "..." })` (v3 — removed in v4)
  - `z.string().min(3, { message: "..." })` (v3 `message` instead of v4 `error`)
  - Using `errorMap` callback (v3 — removed in v4)
- **Rubric:**
  | Criterion | Weight | Description |
  | --- | --- | --- |
  | `error_param` | 30% | Uses `error` parameter, not `message` |
  | `no_required_error` | 20% | Does not use `required_error` |
  | `no_invalid_type_error` | 20% | Does not use `invalid_type_error` |
  | `function_error_handler` | 15% | Schema-level `error` is a function for differentiation |
  | `no_hallucination` | 15% | No invented patterns |

---

### 4.2 Category B1: Version-Locked Write Tasks

#### Next.js 13 (3 tasks)

---

**Task B1-NX-1: Synchronous `cookies()` and `headers()`**

- **ID:** `nextjs-13-sync-request-apis`
- **Prompt:**
  > This project uses **Next.js 13** (App Router). Create a server component at `app/profile/page.tsx` that reads the `session` cookie and the `Accept-Language` header to display a personalized greeting. Write code that is correct for Next.js 13 — do NOT use Next.js 14 or 15 patterns.
- **What it tests:** In Next.js 13, `cookies()` and `headers()` are **synchronous**. An agent influenced by v15 docs would incorrectly `await` them.
- **Reference solution:**

  ```typescript
  import { cookies, headers } from 'next/headers';

  export default async function ProfilePage() {
    const cookieStore = cookies();
    const headersList = headers();

    const session = cookieStore.get('session');
    const lang = headersList.get('accept-language') ?? 'en';

    return (
      <div>
        <h1>Welcome{session ? `, ${session.value}` : ''}</h1>
        <p>Language: {lang}</p>
      </div>
    );
  }
  ```

- **Test spec:**
  - AST: `cookies()` is NOT inside an `await` expression
  - AST: `headers()` is NOT inside an `await` expression
  - AST: imports from `next/headers` (correct)
- **Common hallucinations:**
  - `const cookieStore = await cookies()` (v15 pattern applied to v13)
  - Using `NextRequest` parameter instead of the standalone functions
- **Rubric:**
  | Criterion | Weight | Description |
  | --- | --- | --- |
  | `sync_cookies` | 30% | `cookies()` called without `await` |
  | `sync_headers` | 30% | `headers()` called without `await` |
  | `correct_import` | 20% | Imports from `next/headers` |
  | `no_hallucination` | 20% | No v14/15 patterns |

---

**Task B1-NX-2: Direct `params` Access**

- **ID:** `nextjs-14-direct-params`
- **Prompt:**
  > This project uses **Next.js 14**. Create a dynamic page at `app/blog/[slug]/page.tsx` and a `generateMetadata` function for it. The page should display the blog post slug and the `page` search parameter. Write code that is correct for Next.js 14.
- **What it tests:** In Next.js 14, `params` and `searchParams` are direct objects, NOT Promises.
- **Reference solution:**

  ```typescript
  import { Metadata } from 'next';

  type Props = {
    params: { slug: string };
    searchParams: { page?: string };
  };

  export async function generateMetadata({ params }: Props): Promise<Metadata> {
    return { title: `Blog: ${params.slug}` };
  }

  export default async function BlogPage({ params, searchParams }: Props) {
    return (
      <article>
        <h1>{params.slug}</h1>
        <p>Page: {searchParams.page ?? '1'}</p>
      </article>
    );
  }
  ```

- **Test spec:**
  - AST: `params.slug` accessed directly (no `await`)
  - AST: `searchParams.page` accessed directly (no `await`)
  - AST: `params` type is NOT `Promise<...>`
- **Common hallucinations:**
  - `const { slug } = await params` (v15 pattern)
  - Typing params as `Promise<{ slug: string }>` (v15 type)
- **Rubric:**
  | Criterion | Weight | Description |
  | --- | --- | --- |
  | `direct_params` | 35% | `params` accessed directly, no `await` |
  | `direct_search_params` | 30% | `searchParams` accessed directly, no `await` |
  | `no_promise_type` | 20% | Types don't use `Promise<>` wrapper |
  | `no_hallucination` | 15% | No v15 patterns |

---

**Task B1-NX-3: Next.js 15 `middleware.ts` (Not `proxy.ts`)**

- **ID:** `nextjs-15-middleware-ts`
- **Prompt:**
  > This project uses **Next.js 15**. Create authentication middleware that checks for an `auth-token` cookie on all `/dashboard` routes. If missing, redirect to `/login`. If present, add an `x-user-id` header. Write code correct for Next.js 15 — do NOT use Next.js 16 patterns.
- **What it tests:** In Next.js 15, the file is `middleware.ts` and the exported function is `middleware()`. In v16, this was renamed to `proxy.ts`/`proxy()`. An agent influenced by v16 docs would incorrectly create `proxy.ts`.
- **Reference solution:**

  ```typescript
  // middleware.ts
  import { NextResponse } from "next/server";
  import type { NextRequest } from "next/server";

  export function middleware(request: NextRequest) {
    const token = request.cookies.get("auth-token");

    if (!token) {
      return NextResponse.redirect(new URL("/login", request.url));
    }

    const response = NextResponse.next();
    response.headers.set("x-user-id", token.value);
    return response;
  }

  export const config = {
    matcher: "/dashboard/:path*",
  };
  ```

- **Test spec:**
  - AST: file is named `middleware.ts` (not `proxy.ts`)
  - AST: exports a function named `middleware` (not `proxy`)
  - AST: does NOT export a function named `proxy`
- **Common hallucinations:**
  - Creating `proxy.ts` instead of `middleware.ts` (v16 pattern)
  - `export function proxy(request: NextRequest)` (v16 function name)
- **Rubric:**
  | Criterion | Weight | Description |
  | --- | --- | --- |
  | `middleware_filename` | 30% | File is `middleware.ts`, not `proxy.ts` |
  | `middleware_function_name` | 30% | Exports `function middleware()`, not `function proxy()` |
  | `correct_api_usage` | 25% | Correctly uses NextResponse, cookies, redirect, matcher |
  | `no_hallucination` | 15% | No v16 proxy patterns |

---

#### React 17 (3 tasks)

---

**Task B1-RX-1: Data Fetching with useEffect**

- **ID:** `react-17-data-fetching`
- **Prompt:**
  > This project uses **React 17**. Create a `UserProfile` component that fetches user data from `/api/users/:id` on mount and displays the user's name and email. Handle loading and error states. Write code that only uses React 17 APIs.
- **What it tests:** In React 17, data fetching is done with `useEffect` + `useState`. There's no `use()` hook, no Suspense for data, no `useTransition`.
- **Reference solution:**

  ```tsx
  import React, { useState, useEffect } from "react";

  type User = { id: string; name: string; email: string };

  export default function UserProfile({ userId }: { userId: string }) {
    const [user, setUser] = useState<User | null>(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
      let cancelled = false;
      setLoading(true);

      fetch(`/api/users/${userId}`)
        .then((res) => res.json())
        .then((data) => {
          if (!cancelled) {
            setUser(data);
            setLoading(false);
          }
        })
        .catch((err) => {
          if (!cancelled) {
            setError(err.message);
            setLoading(false);
          }
        });

      return () => {
        cancelled = true;
      };
    }, [userId]);

    if (loading) return <div>Loading...</div>;
    if (error) return <div>Error: {error}</div>;
    if (!user) return null;

    return (
      <div>
        <h1>{user.name}</h1>
        <p>{user.email}</p>
      </div>
    );
  }
  ```

- **Test spec:**
  - AST: uses `useState` and `useEffect` for data fetching
  - AST: does NOT import `use` from `react`
  - AST: does NOT import `useTransition` or `useDeferredValue`
  - AST: does NOT use `Suspense` for data loading
  - AST: does NOT use `useId`
- **Common hallucinations:**
  - Using `use()` hook (React 19 only)
  - Using `useTransition` for loading state (React 18+)
  - Wrapping in `<Suspense>` for data fetching (React 19 pattern)
- **Rubric:**
  | Criterion | Weight | Description |
  | --- | --- | --- |
  | `useeffect_pattern` | 30% | Uses useEffect for data fetching |
  | `usestate_for_state` | 20% | Uses useState for loading/error/data |
  | `no_react18_hooks` | 25% | No useTransition, useId, useDeferredValue |
  | `no_react19_hooks` | 15% | No use(), useActionState, useFormStatus |
  | `no_hallucination` | 10% | No invented patterns |

---

**Task B1-RX-2: ReactDOM.render Entry Point**

- **ID:** `react-17-render-entry`
- **Prompt:**
  > This project uses **React 17**. Create the entry point file `src/index.tsx` that renders the `<App />` component into the DOM element with id `root`. Write code correct for React 17 — do NOT use `createRoot`.
- **What it tests:** React 17 uses `ReactDOM.render()` which was removed in React 19. An agent influenced by v18/19 docs would use `createRoot`.
- **Reference solution:**

  ```tsx
  import React from "react";
  import ReactDOM from "react-dom";
  import App from "./App";

  ReactDOM.render(
    <React.StrictMode>
      <App />
    </React.StrictMode>,
    document.getElementById("root"),
  );
  ```

- **Test spec:**
  - AST: calls `ReactDOM.render()` (not `createRoot().render()`)
  - AST: imports `ReactDOM` from `react-dom` (not `react-dom/client`)
  - AST: does NOT import `createRoot`
- **Common hallucinations:**
  - `import { createRoot } from 'react-dom/client'` (v18+ pattern)
  - `createRoot(document.getElementById('root')).render(...)` (v18+)
- **Rubric:**
  | Criterion | Weight | Description |
  | --- | --- | --- |
  | `reactdom_render` | 40% | Uses `ReactDOM.render()` |
  | `correct_import` | 30% | Imports from `react-dom`, not `react-dom/client` |
  | `no_create_root` | 20% | Does not use `createRoot` |
  | `no_hallucination` | 10% | No invented patterns |

---

**Task B1-RX-3: forwardRef for Ref Passing**

- **ID:** `react-18-forward-ref`
- **Prompt:**
  > This project uses **React 18**. Create a reusable `CustomInput` component that exposes its internal `<input>` element's ref to parent components. Use the correct React 18 approach for ref forwarding. Then create a parent that focuses the input on button click.
- **What it tests:** React 18 requires `forwardRef` for ref passing. React 19 deprecated it in favor of `ref` as prop.
- **Reference solution:**

  ```tsx
  import { forwardRef, useRef } from "react";

  const CustomInput = forwardRef<HTMLInputElement, { placeholder?: string }>(
    ({ placeholder }, ref) => {
      return <input ref={ref} placeholder={placeholder} />;
    },
  );
  CustomInput.displayName = "CustomInput";

  export default function SearchForm() {
    const inputRef = useRef<HTMLInputElement>(null);

    return (
      <div>
        <CustomInput ref={inputRef} placeholder="Search..." />
        <button onClick={() => inputRef.current?.focus()}>Focus</button>
      </div>
    );
  }
  ```

- **Test spec:**
  - AST: uses `forwardRef` (imported from `react`)
  - AST: does NOT accept `ref` as a regular prop in the component function
- **Common hallucinations:**
  - Using `ref` as a regular prop (React 19 pattern)
  - Not using `forwardRef` at all
- **Rubric:**
  | Criterion | Weight | Description |
  | --- | --- | --- |
  | `uses_forward_ref` | 40% | Uses `forwardRef` wrapper |
  | `correct_generic_types` | 20% | Typed with `forwardRef<HTMLInputElement, Props>` |
  | `ref_not_in_props` | 25% | `ref` is the second argument of forwardRef, not in props |
  | `no_hallucination` | 15% | No React 19 patterns |

---

#### Vercel AI SDK v3 (2 tasks)

---

**Task B1-AI-1: Await `streamText` (v3 Async)**

- **ID:** `ai-sdk-3-async-stream`
- **Prompt:**
  > This project uses **Vercel AI SDK v3**. Create a Next.js Route Handler that streams a chat response. Use `experimental_streamText` with the proper v3 async pattern and `toAIStreamResponse()`. Use `openai('gpt-3.5-turbo')` as the model.
- **What it tests:** AI SDK v3 uses `experimental_` prefixes and async `await` on stream functions. Response method is `toAIStreamResponse()`.
- **Reference solution:**

  ```typescript
  import { experimental_streamText } from "ai";
  import { openai } from "@ai-sdk/openai";

  export async function POST(req: Request) {
    const { messages } = await req.json();

    const result = await experimental_streamText({
      model: openai("gpt-3.5-turbo"),
      messages,
    });

    return result.toAIStreamResponse();
  }
  ```

- **Test spec:**
  - AST: imports `experimental_streamText` (not `streamText`)
  - AST: `experimental_streamText()` is inside an `await` expression
  - AST: calls `toAIStreamResponse()` (not `toDataStreamResponse`)
- **Common hallucinations:**
  - Using `streamText` without `experimental_` prefix (v4+)
  - Calling without `await` (v4+ sync pattern)
  - Using `toDataStreamResponse()` (v4)
- **Rubric:**
  | Criterion | Weight | Description |
  | --- | --- | --- |
  | `experimental_prefix` | 30% | Uses `experimental_streamText` |
  | `await_required` | 30% | Awaits the stream call |
  | `ai_stream_response` | 25% | Uses `toAIStreamResponse()` |
  | `no_hallucination` | 15% | No v4/v5 patterns |

---

**Task B1-AI-2: v3 Type Names**

- **ID:** `ai-sdk-3-type-names`
- **Prompt:**
  > This project uses **Vercel AI SDK v3**. Define TypeScript types for a chat message handler that processes messages and tracks token usage. Import the correct v3 type names for messages and token usage from the `ai` package.
- **What it tests:** AI SDK v3 used `ExperimentalMessage` and `TokenUsage` types, which were renamed to `CoreMessage` and `LanguageModelUsage` in v4.
- **Reference solution:**

  ```typescript
  import type { ExperimentalMessage, TokenUsage } from "ai";

  interface ChatResult {
    messages: ExperimentalMessage[];
    usage: TokenUsage;
  }

  export function processChat(result: ChatResult) {
    console.log(`Messages: ${result.messages.length}`);
    console.log(`Tokens: ${result.usage.totalTokens}`);
  }
  ```

- **Test spec:**
  - AST: imports `ExperimentalMessage` (not `CoreMessage`)
  - AST: imports `TokenUsage` (not `LanguageModelUsage`)
- **Rubric:**
  | Criterion | Weight | Description |
  | --- | --- | --- |
  | `experimental_message_type` | 35% | Uses `ExperimentalMessage`, not `CoreMessage` |
  | `token_usage_type` | 35% | Uses `TokenUsage`, not `LanguageModelUsage` |
  | `no_hallucination` | 30% | No v4 type names |

---

#### tRPC v10 (3 tasks)

---

**Task B1-TR-1: Client-Level Transformer**

- **ID:** `trpc-10-client-transformer`
- **Prompt:**
  > This project uses **tRPC v10**. Set up the tRPC client with `superjson` transformer and `httpBatchLink`. The API is at `http://localhost:3000/api/trpc`. Write code correct for tRPC v10.
- **What it tests:** In tRPC v10, the transformer is configured at the top-level client config, not inside the link. Also uses `createTRPCProxyClient` (v10 name).
- **Reference solution:**

  ```typescript
  import { createTRPCProxyClient, httpBatchLink } from "@trpc/client";
  import superjson from "superjson";
  import type { AppRouter } from "../server/router";

  export const trpc = createTRPCProxyClient<AppRouter>({
    transformer: superjson,
    links: [
      httpBatchLink({
        url: "http://localhost:3000/api/trpc",
      }),
    ],
  });
  ```

- **Test spec:**
  - AST: `transformer` is at `createTRPCProxyClient({})` level, NOT inside link
  - AST: uses `createTRPCProxyClient` (not `createTRPCClient`)
- **Rubric:**
  | Criterion | Weight | Description |
  | --- | --- | --- |
  | `transformer_at_client` | 35% | `transformer` at client config level |
  | `correct_client_fn` | 30% | Uses `createTRPCProxyClient` |
  | `correct_import` | 15% | Imports from `@trpc/client` |
  | `no_hallucination` | 20% | No v11 patterns |

---

**Task B1-TR-2: v10 Middleware with `rawInput`**

- **ID:** `trpc-10-middleware-raw-input`
- **Prompt:**
  > This project uses **tRPC v10**. Create an authentication middleware that checks for a `userId` in the raw input and extends the context with user data. Use the v10 middleware API with direct `rawInput` access.
- **Reference solution:**

  ```typescript
  import { initTRPC, TRPCError } from "@trpc/server";

  const t = initTRPC.context<{ userId?: string }>().create();

  const isAuthed = t.middleware(({ ctx, rawInput, next }) => {
    if (!ctx.userId) {
      throw new TRPCError({ code: "UNAUTHORIZED" });
    }

    return next({
      ctx: { userId: ctx.userId },
    });
  });

  export const protectedProcedure = t.procedure.use(isAuthed);
  ```

- **Test spec:**
  - AST: middleware uses `rawInput` directly (not `getRawInput()`)
- **Rubric:**
  | Criterion | Weight | Description |
  | --- | --- | --- |
  | `raw_input_direct` | 40% | Uses `rawInput` property directly |
  | `not_get_raw_input` | 30% | Does NOT use `getRawInput()` (v11 method) |
  | `correct_middleware_api` | 15% | Properly chains with `next()` |
  | `no_hallucination` | 15% | No v11 patterns |

---

**Task B1-TR-3: v10 SSG Helpers**

- **ID:** `trpc-10-ssg-helpers`
- **Prompt:**
  > This project uses **tRPC v10** with Next.js Pages Router. Create `getStaticProps` for a blog page that prefetches the `post.bySlug` procedure using tRPC's SSG helpers. Use the correct v10 helper function.
- **Reference solution:**

  ```typescript
  import { createProxySSGHelpers } from "@trpc/react-query/ssg";
  import superjson from "superjson";
  import { appRouter } from "../../server/router";

  export async function getStaticProps(context: { params: { slug: string } }) {
    const ssg = createProxySSGHelpers({
      router: appRouter,
      ctx: {},
      transformer: superjson,
    });

    await ssg.post.bySlug.prefetch({ slug: context.params.slug });

    return {
      props: {
        trpcState: ssg.dehydrate(),
      },
      revalidate: 60,
    };
  }
  ```

- **Test spec:**
  - AST: imports `createProxySSGHelpers` (not `createSSGHelpers`)
  - AST: imports from `@trpc/react-query/ssg`
- **Rubric:**
  | Criterion | Weight | Description |
  | --- | --- | --- |
  | `correct_helper_fn` | 40% | Uses `createProxySSGHelpers`, not `createSSGHelpers` (v11 name) |
  | `correct_import_path` | 25% | Imports from `@trpc/react-query/ssg` |
  | `correct_usage` | 20% | Properly calls `prefetch` and `dehydrate` |
  | `no_hallucination` | 15% | No v11 patterns |

---

#### Zod v3 (3 tasks)

---

**Task B1-ZD-1: Chained String Validators**

- **ID:** `zod-3-chained-validators`
- **Prompt:**
  > This project uses **Zod v3**. Create a schema for a server configuration object that validates: email (valid format), API endpoint (valid URL), request ID (valid UUID), and server IP (valid IP address, either v4 or v6). Use Zod v3's chained string validator pattern.
- **Reference solution:**

  ```typescript
  import { z } from "zod";

  const serverConfigSchema = z.object({
    adminEmail: z.string().email(),
    apiEndpoint: z.string().url(),
    requestId: z.string().uuid(),
    serverIp: z.string().ip(),
  });
  ```

- **Test spec:**
  - AST: uses `z.string().email()` (not `z.email()`)
  - AST: uses `z.string().url()` (not `z.url()`)
  - AST: uses `z.string().ip()` (not `z.ipv4()` / `z.ipv6()`)
- **Rubric:**
  | Criterion | Weight | Description |
  | --- | --- | --- |
  | `chained_email` | 20% | Uses `z.string().email()` |
  | `chained_url` | 20% | Uses `z.string().url()` |
  | `chained_uuid` | 20% | Uses `z.string().uuid()` |
  | `chained_ip` | 25% | Uses `z.string().ip()`, not `z.ipv4()` |
  | `no_hallucination` | 15% | No v4 patterns |

---

**Task B1-ZD-2: Error Customization (v3 `message` param)**

- **ID:** `zod-3-error-message`
- **Prompt:**
  > This project uses **Zod v3**. Create a schema for a password field that is at least 8 characters with custom error messages: a `required_error` when the field is missing, an `invalid_type_error` when it's not a string, and a custom `message` for the min length check. Use Zod v3's error API.
- **Reference solution:**

  ```typescript
  import { z } from "zod";

  const passwordSchema = z
    .string({
      required_error: "Password is required",
      invalid_type_error: "Password must be a string",
    })
    .min(8, { message: "Password must be at least 8 characters" });
  ```

- **Test spec:**
  - AST: uses `required_error` property in schema config
  - AST: uses `invalid_type_error` property in schema config
  - AST: uses `message` property in `.min()` (not `error`)
  - AST: does NOT use `error` property
- **Rubric:**
  | Criterion | Weight | Description |
  | --- | --- | --- |
  | `required_error` | 25% | Uses `required_error` (removed in v4) |
  | `invalid_type_error` | 25% | Uses `invalid_type_error` (removed in v4) |
  | `message_param` | 25% | Uses `message`, not `error` |
  | `no_hallucination` | 25% | No v4 patterns |

---

**Task B1-ZD-3: `z.record()` Single Argument**

- **ID:** `zod-3-record-single-arg`
- **Prompt:**
  > This project uses **Zod v3**. Create a schema for an HTTP headers object where keys are strings and values are strings. Also create a schema for environment variables where keys from a known set (`DATABASE_URL`, `API_KEY`, `PORT`) map to string values. Use `z.record()` with Zod v3 syntax.
- **Reference solution:**

  ```typescript
  import { z } from "zod";

  // Simple record: string -> string
  const headersSchema = z.record(z.string());

  // Enum-keyed record
  const envSchema = z.record(
    z.enum(["DATABASE_URL", "API_KEY", "PORT"]),
    z.string(),
  );

  type Headers = z.infer<typeof headersSchema>;
  type Env = z.infer<typeof envSchema>;
  ```

- **Test spec:**
  - AST: `z.record(z.string())` with single argument (v3 allows this)
  - AST: does NOT exclusively use two arguments for the simple case
- **Rubric:**
  | Criterion | Weight | Description |
  | --- | --- | --- |
  | `single_arg_record` | 40% | Uses `z.record(z.string())` with one arg |
  | `enum_keyed_record` | 30% | Correctly creates enum-keyed record |
  | `correct_types` | 15% | `z.infer` produces correct types |
  | `no_hallucination` | 15% | No v4 patterns |

---

### 4.3 Category B2: Version-Locked Audit Tasks

#### Next.js Audit Tasks (3 tasks)

---

**Task B2-NX-1: Audit Next.js 16 Code for v13 Compatibility**

- **ID:** `nextjs-13-audit-v16-code`
- **Prompt:**
  > This project uses **Next.js 13**. Audit the following code and identify all APIs or patterns that are NOT available in Next.js 13. For each issue, explain why it's invalid and provide the correct Next.js 13 alternative.
  >
  > ```typescript
  > // proxy.ts
  > import { NextResponse } from 'next/server';
  > import type { NextRequest } from 'next/server';
  >
  > export function proxy(request: NextRequest) {
  >   const token = request.cookies.get('auth-token');
  >   if (!token) return NextResponse.redirect(new URL('/login', request.url));
  >   return NextResponse.next();
  > }
  >
  > // app/dashboard/page.tsx
  > 'use cache';
  > import { cookies } from 'next/headers';
  > import { after } from 'next/server';
  > import { cacheTag, cacheLife, updateTag } from 'next/cache';
  >
  > cacheLife('hours');
  > cacheTag('dashboard');
  >
  > export default async function Dashboard({ params }: { params: Promise<{ id: string }> }) {
  >   const { id } = await params;
  >   const cookieStore = await cookies();
  >   const token = cookieStore.get('token');
  >
  >   after(() => {
  >     console.log('Dashboard viewed:', id);
  >   });
  >
  >   return <div>Dashboard {id}</div>;
  > }
  > ```
- **Expected issues to identify:**
  1. `proxy.ts` / `export function proxy()` — v13 uses `middleware.ts` / `export function middleware()`
  2. `'use cache'` directive — does not exist in v13 (v16 only)
  3. `await params` — v13 params are direct objects, not Promises
  4. `await cookies()` — v13 `cookies()` is synchronous
  5. `after()` — does not exist in v13 (v15+)
  6. `cacheTag()`, `cacheLife()`, `updateTag()` — do not exist in v13 (v16 only)
  7. `params: Promise<{ id: string }>` — wrong type, should be `{ id: string }`
- **Rubric:**
  | Criterion | Weight | Description |
  | --- | --- | --- |
  | `identify_proxy_rename` | 15% | Identifies `proxy.ts`/`proxy()` as v16-only, should be `middleware.ts`/`middleware()` |
  | `identify_use_cache` | 15% | Identifies `'use cache'` as v16-only |
  | `identify_async_params` | 15% | Identifies `await params` as invalid for v13 |
  | `identify_async_cookies` | 15% | Identifies `await cookies()` as invalid for v13 |
  | `identify_after` | 10% | Identifies `after()` as v15+ only |
  | `identify_cache_apis` | 10% | Identifies `cacheTag`/`cacheLife`/`updateTag` as v16-only |
  | `correct_alternatives` | 20% | Provides correct v13 alternatives |

---

**Task B2-NX-2: Audit v15 Code Upgrading to v16**

- **ID:** `nextjs-16-audit-v15-code`
- **Prompt:**
  > This project is upgrading from **Next.js 15 to Next.js 16**. Audit the following code and identify every pattern that is broken, deprecated, or renamed in Next.js 16. For each issue, provide the correct v16 replacement.
  >
  > ```typescript
  > // middleware.ts
  > import { NextResponse } from "next/server";
  > import type { NextRequest } from "next/server";
  >
  > export function middleware(request: NextRequest) {
  >   return NextResponse.next();
  > }
  >
  > export const config = {
  >   matcher: "/dashboard/:path*",
  > };
  >
  > // next.config.js
  > module.exports = {
  >   experimental: {
  >     turbopack: {
  >       /* options */
  >     },
  >     dynamicIO: true,
  >     ppr: true,
  >   },
  >   eslint: { dirs: ["src"] },
  >   serverRuntimeConfig: { secret: process.env.SECRET },
  > };
  >
  > // package.json scripts
  > // "lint": "next lint"
  > ```
- **Expected issues to identify:**
  1. `middleware.ts` / `export function middleware()` — renamed to `proxy.ts` / `export function proxy()` in v16
  2. `experimental.turbopack` — moved to top-level `turbopack` in v16
  3. `experimental.dynamicIO` — renamed to `cacheComponents` in v16
  4. `experimental.ppr` — removed in v16, use `cacheComponents: true` instead
  5. `eslint` config in `next.config.js` — removed in v16 (`next lint` removed)
  6. `serverRuntimeConfig` — removed in v16, use environment variables
  7. `next lint` script — command removed in v16, use `eslint` CLI directly
- **Rubric:**
  | Criterion | Weight | Description |
  | --- | --- | --- |
  | `identify_middleware_rename` | 20% | `middleware.ts`/`middleware()` -> `proxy.ts`/`proxy()` |
  | `identify_turbopack_move` | 15% | `experimental.turbopack` -> top-level `turbopack` |
  | `identify_dynamicio_rename` | 15% | `experimental.dynamicIO` -> `cacheComponents` |
  | `identify_ppr_removal` | 10% | `experimental.ppr` removed |
  | `identify_eslint_removal` | 10% | `eslint` config and `next lint` removed |
  | `identify_runtime_config` | 10% | `serverRuntimeConfig` removed |
  | `correct_replacements` | 20% | Provides correct v16 alternatives |

---

**Task B2-NX-3: Audit v16 Code for Missing Parallel Route Defaults**

- **ID:** `nextjs-16-audit-parallel-routes`
- **Prompt:**
  > This project uses **Next.js 16**. The build is failing with errors about parallel routes. Audit the following file structure and code, identify the issues, and explain the fixes.
  >
  > ```
  > app/
  >   layout.tsx         # uses @sidebar and @modal slots
  >   page.tsx
  >   @sidebar/
  >     page.tsx          # sidebar content
  >   @modal/
  >     (.)photo/
  >       [id]/
  >         page.tsx      # intercepted modal route
  > ```
  >
  > ```typescript
  > // app/layout.tsx
  > export default function RootLayout({
  >   children,
  >   sidebar,
  >   modal,
  > }: {
  >   children: React.ReactNode;
  >   sidebar: React.ReactNode;
  >   modal: React.ReactNode;
  > }) {
  >   return (
  >     <html>
  >       <body>
  >         <div>{sidebar}</div>
  >         <main>{children}</main>
  >         {modal}
  >       </body>
  >     </html>
  >   );
  > }
  > ```
- **Expected issues to identify:**
  1. `@sidebar/` is missing a `default.tsx` file — required in v16 for all parallel route slots
  2. `@modal/` is missing a `default.tsx` file — required in v16 for all parallel route slots
  3. Each slot needs an explicit `default.tsx` that returns `null` or calls `notFound()`
- **Rubric:**
  | Criterion | Weight | Description |
  | --- | --- | --- |
  | `identify_sidebar_default` | 30% | Identifies `@sidebar` needs a `default.tsx` |
  | `identify_modal_default` | 30% | Identifies `@modal` needs a `default.tsx` |
  | `correct_fix` | 25% | Provides correct `default.tsx` implementation (return null or notFound) |
  | `explains_v16_requirement` | 15% | Explains this is a v16 requirement (was optional in v15) |

---

#### React Audit Tasks (3 tasks)

---

**Task B2-RX-1: Audit React 19 Code for v17 Compatibility**

- **ID:** `react-17-audit-v19-code`
- **Prompt:**
  > This project uses **React 17**. Audit the following code and identify all APIs that are NOT available in React 17. For each, explain the issue and provide the React 17 alternative.
  >
  > ```tsx
  > import { use, useId, useActionState } from "react";
  > import { useFormStatus } from "react-dom";
  > import { createRoot } from "react-dom/client";
  >
  > function Form({ dataPromise }) {
  >   const data = use(dataPromise);
  >   const formId = useId();
  >   const [state, action] = useActionState(submitAction, null);
  >   const { pending } = useFormStatus();
  >
  >   return (
  >     <form id={formId} action={action}>
  >       <MyInput ref={inputRef} />
  >       <button disabled={pending}>Submit</button>
  >     </form>
  >   );
  > }
  >
  > createRoot(document.getElementById("root")).render(<Form />);
  > ```
- **Expected issues to identify:**
  1. `use` — React 19 only
  2. `useId` — React 18+ only
  3. `useActionState` — React 19 only
  4. `useFormStatus` — React 19 only
  5. `createRoot` — React 18+ only (should use `ReactDOM.render`)
  6. `ref` as prop on `<MyInput>` — React 19 only (needs `forwardRef` in 17)
  7. `action` prop on `<form>` — React 19 Server Actions
- **Rubric:**
  | Criterion | Weight | Description |
  | --- | --- | --- |
  | `identify_all_invalid_hooks` | 30% | Identifies use, useId, useActionState, useFormStatus |
  | `identify_create_root` | 20% | Identifies createRoot as v18+ |
  | `identify_ref_as_prop` | 15% | Identifies ref as prop needs forwardRef in v17 |
  | `identify_form_action` | 15% | Identifies form action as v19 feature |
  | `correct_alternatives` | 20% | Provides correct React 17 alternatives |

---

**Task B2-RX-2: Detect Removed APIs in React 19**

- **ID:** `react-19-audit-removed-apis`
- **Prompt:**
  > This project just upgraded to **React 19**. Audit the following code for APIs that were removed or deprecated in React 19 and suggest the correct replacements.
  >
  > ```tsx
  > import React from "react";
  > import ReactDOM from "react-dom";
  > import PropTypes from "prop-types";
  >
  > const MyInput = React.forwardRef((props, ref) => {
  >   return <input ref={ref} {...props} />;
  > });
  >
  > MyInput.defaultProps = { placeholder: "Enter text..." };
  > MyInput.propTypes = { placeholder: PropTypes.string };
  >
  > function App() {
  >   return (
  >     <MyContext.Provider value="dark">
  >       <MyInput ref="inputRef" />
  >     </MyContext.Provider>
  >   );
  > }
  >
  > ReactDOM.render(<App />, document.getElementById("root"));
  > ```
- **Expected issues to identify:**
  1. `ReactDOM.render` — removed in React 19, use `createRoot`
  2. `defaultProps` on function — removed in React 19, use default params
  3. `PropTypes` — removed from React core in 19
  4. `forwardRef` — deprecated in React 19, use `ref` as prop
  5. `ref="inputRef"` — string refs removed in React 19
  6. `<MyContext.Provider>` — can use `<MyContext>` directly in 19 (optional)
- **Rubric:**
  | Criterion | Weight | Description |
  | --- | --- | --- |
  | `identify_render_removed` | 20% | ReactDOM.render removed |
  | `identify_defaultprops` | 20% | defaultProps removed on functions |
  | `identify_proptypes` | 15% | PropTypes removed |
  | `identify_forwardref` | 15% | forwardRef deprecated |
  | `identify_string_ref` | 15% | String refs removed |
  | `correct_replacements` | 15% | Provides correct React 19 alternatives |

---

**Task B2-RX-3: Audit React 18 Code for Missing Concurrent Features**

- **ID:** `react-18-audit-missed-features`
- **Prompt:**
  > This project uses **React 18** but the code below only uses React 17 patterns. Identify where React 18 features should be used for better UX and suggest the correct React 18 APIs.
  >
  > ```tsx
  > import React from "react";
  > import ReactDOM from "react-dom";
  >
  > function SearchResults({ query }) {
  >   const [results, setResults] = React.useState([]);
  >   const [isLoading, setIsLoading] = React.useState(false);
  >
  >   React.useEffect(() => {
  >     setIsLoading(true);
  >     fetch(`/api/search?q=${query}`)
  >       .then((r) => r.json())
  >       .then((data) => {
  >         setResults(data);
  >         setIsLoading(false);
  >       });
  >   }, [query]);
  >
  >   return isLoading ? (
  >     <p>Loading...</p>
  >   ) : (
  >     <ul>
  >       {results.map((r) => (
  >         <li key={r.id}>{r.name}</li>
  >       ))}
  >     </ul>
  >   );
  > }
  >
  > ReactDOM.render(<App />, document.getElementById("root"));
  > ```
- **Expected issues to identify:**
  1. `ReactDOM.render` should be `createRoot` in React 18
  2. Could use `useTransition` or `useDeferredValue` for non-urgent query updates
  3. Could use `useId` for generating stable IDs if needed
  4. Missing concurrent rendering benefits without `createRoot`
- **Rubric:**
  | Criterion | Weight | Description |
  | --- | --- | --- |
  | `identify_render_upgrade` | 30% | Should use createRoot |
  | `suggest_concurrent` | 30% | Suggests useTransition or useDeferredValue |
  | `correct_v18_apis` | 25% | Uses correct React 18 API names |
  | `no_v19_suggestions` | 15% | Doesn't suggest React 19-only features |

---

#### Zod / tRPC / AI SDK Audit Tasks (3 tasks)

---

**Task B2-ZD-1: Audit Zod v3 Code for v4 Migration**

- **ID:** `zod-4-audit-v3-code`
- **Prompt:**
  > This project is upgrading from **Zod v3 to v4**. Audit the following code and identify every pattern that is deprecated or broken in Zod v4. For each, provide the correct v4 replacement.
  >
  > ```typescript
  > import { z } from "zod";
  >
  > const userSchema = z
  >   .object({
  >     email: z.string().email({ message: "Invalid email" }),
  >     ip: z.string().ip({ version: "v4" }),
  >     config: z.record(z.number()),
  >     name: z
  >       .string({
  >         required_error: "Name required",
  >         invalid_type_error: "Name must be text",
  >       })
  >       .min(2, { message: "Too short" }),
  >   })
  >   .deepPartial();
  >
  > const result = userSchema.safeParse(data);
  > if (!result.success) {
  >   const formatted = result.error.format();
  >   const flat = result.error.flatten();
  > }
  > ```
- **Expected issues to identify:**
  1. `.email({ message: ... })` — `message` deprecated, use `error`
  2. `.ip({ version: 'v4' })` — removed in v4, use `z.ipv4()`
  3. `z.record(z.number())` — single arg removed in v4, use `z.record(z.string(), z.number())`
  4. `required_error` / `invalid_type_error` — removed in v4, use `error` function
  5. `{ message: 'Too short' }` — `message` deprecated, use `error`
  6. `.deepPartial()` — removed in v4
  7. `.format()` and `.flatten()` — deprecated in v4, use `z.treeifyError()`
- **Rubric:**
  | Criterion | Weight | Description |
  | --- | --- | --- |
  | `identify_message_deprecation` | 15% | `message` -> `error` |
  | `identify_ip_removal` | 15% | `.ip()` removed |
  | `identify_record_change` | 15% | Single-arg `z.record()` broken |
  | `identify_error_params` | 15% | `required_error`/`invalid_type_error` removed |
  | `identify_deep_partial` | 10% | `.deepPartial()` removed |
  | `identify_format_flatten` | 10% | `.format()`/`.flatten()` deprecated |
  | `correct_replacements` | 20% | Provides correct v4 alternatives |

---

**Task B2-TR-1: Audit tRPC v10 Code for v11 Migration**

- **ID:** `trpc-11-audit-v10-code`
- **Prompt:**
  > This project is upgrading from **tRPC v10 to v11**. Audit the following code and identify every pattern that is broken or renamed in tRPC v11.
  >
  > ```typescript
  > import { createTRPCProxyClient, httpBatchLink } from "@trpc/client";
  > import { createProxySSGHelpers } from "@trpc/react-query/ssg";
  > import superjson from "superjson";
  >
  > const client = createTRPCProxyClient<AppRouter>({
  >   transformer: superjson,
  >   links: [httpBatchLink({ url: "/api/trpc" })],
  > });
  >
  > // middleware
  > const myMiddleware = t.middleware(({ rawInput, next }) => {
  >   console.log(rawInput);
  >   return next();
  > });
  > ```
- **Expected issues to identify:**
  1. `createTRPCProxyClient` — renamed to `createTRPCClient` in v11
  2. `createProxySSGHelpers` — renamed to `createSSGHelpers` in v11
  3. `transformer` at client level — must move to link config in v11
  4. `rawInput` — renamed to `getRawInput()` function in v11
- **Rubric:**
  | Criterion | Weight | Description |
  | --- | --- | --- |
  | `identify_client_rename` | 25% | `createTRPCProxyClient` -> `createTRPCClient` |
  | `identify_ssg_rename` | 25% | `createProxySSGHelpers` -> `createSSGHelpers` |
  | `identify_transformer_move` | 25% | Transformer must move to link config |
  | `identify_raw_input` | 15% | `rawInput` -> `getRawInput()` |
  | `correct_replacements` | 10% | Provides correct v11 code |

---

**Task B2-AI-1: Audit AI SDK v3 Code for v4 Migration**

- **ID:** `ai-sdk-4-audit-v3-code`
- **Prompt:**
  > This project is upgrading from **Vercel AI SDK v3 to v4**. Audit the following code and identify every pattern that is broken in v4.
  >
  > ```typescript
  > import { experimental_streamText, experimental_generateText } from "ai";
  > import { OpenAI } from "openai";
  >
  > export async function POST(req: Request) {
  >   const { messages } = await req.json();
  >   const result = await experimental_streamText({
  >     model: new OpenAI({ apiKey: process.env.OPENAI_API_KEY }),
  >     messages,
  >     maxToolRoundtrips: 2,
  >   });
  >   return result.toAIStreamResponse();
  > }
  > ```
- **Expected issues to identify:**
  1. `experimental_streamText` — renamed to `streamText` (no prefix) in v4
  2. `experimental_generateText` — renamed to `generateText` in v4
  3. `await` on `streamText` — v4 is synchronous (no await)
  4. `new OpenAI()` — v4 uses `createOpenAI()` factory or `openai()` from `@ai-sdk/openai`
  5. `maxToolRoundtrips` — renamed to `maxSteps` in v4 (and value = roundtrips + 1)
  6. `toAIStreamResponse()` — renamed to `toDataStreamResponse()` in v4
- **Rubric:**
  | Criterion | Weight | Description |
  | --- | --- | --- |
  | `identify_experimental_prefix` | 15% | experimental\_ prefix removed |
  | `identify_async_change` | 20% | await no longer needed |
  | `identify_provider_init` | 15% | Provider initialization changed |
  | `identify_roundtrips_rename` | 15% | maxToolRoundtrips -> maxSteps |
  | `identify_response_rename` | 15% | toAIStreamResponse -> toDataStreamResponse |
  | `correct_replacements` | 20% | Provides correct v4 code |

---

**Task B2-AI-2: Audit AI SDK v4 Streaming Code for v5 Migration**

- **ID:** `ai-sdk-5-audit-v4-streaming`
- **Prompt:**
  > This project is upgrading from **Vercel AI SDK v4 to v5**. Audit the following code and identify every pattern that is broken or removed in v5.
  >
  > ```typescript
  > import {
  >   streamText,
  >   createDataStreamResponse,
  >   StreamData,
  >   formatDataStreamPart,
  > } from "ai";
  > import type { Message } from "ai";
  > import { getTextFromDataUrl } from "@ai-sdk/ui-utils";
  > import { openai } from "@ai-sdk/openai";
  >
  > export async function POST(req: Request) {
  >   const { messages } = await req.json();
  >   const streamData = new StreamData();
  >   streamData.append({ status: "processing" });
  >   return createDataStreamResponse({
  >     execute: (dataStream) => {
  >       dataStream.writeData("initialized call");
  >       dataStream.write(formatDataStreamPart("text", "Processing..."));
  >       const result = streamText({ model: openai("gpt-4o"), messages });
  >       result.mergeIntoDataStream(dataStream);
  >     },
  >   });
  > }
  > ```
- **Expected issues to identify:**
  1. `StreamData` class — removed in v5, use `createUIMessageStream()` with writer
  2. `createDataStreamResponse` — renamed to `createUIMessageStreamResponse`
  3. `writeData()`/`formatDataStreamPart()` — replaced by `writer.write({ type, value })`
  4. `mergeIntoDataStream()` — replaced by `writer.merge(result.toUIMessageStream())`
  5. `toDataStreamResponse()` — renamed to `toUIMessageStreamResponse()`
  6. `@ai-sdk/ui-utils` import — package removed, use main `'ai'` package
  7. `chunk.textDelta` — renamed to `chunk.text` in fullStream
  8. `Message` type with `.content` — renamed to `UIMessage` with `.parts` array
- **Rubric:**
  | Criterion | Weight | Description |
  | --- | --- | --- |
  | `identify_stream_data_removal` | 15% | StreamData removed |
  | `identify_response_rename` | 15% | DataStream response APIs renamed |
  | `identify_writer_api_change` | 15% | Writer API restructured |
  | `identify_package_removal` | 10% | @ai-sdk/ui-utils removed |
  | `identify_chunk_property` | 10% | textDelta → text |
  | `identify_message_type_change` | 15% | Message → UIMessage |
  | `correct_replacements` | 20% | Correct v5 alternatives |

---

**Task B2-TR-2: Audit tRPC v10 Subscription Code for v11 Migration**

- **ID:** `trpc-11-audit-v10-subscriptions`
- **Prompt:**
  > This project is upgrading from **tRPC v10 to v11**. The following code uses v10 subscription and real-time patterns. Audit it and identify every pattern that is deprecated or broken in tRPC v11.
  >
  > ```typescript
  > import { initTRPC } from "@trpc/server";
  > import { observable } from "@trpc/server/observable";
  > import {
  >   createTRPCProxyClient,
  >   httpBatchLink,
  >   wsLink,
  >   splitLink,
  > } from "@trpc/client";
  >
  > const appRouter = t.router({
  >   onUserUpdate: t.procedure.subscription(() => {
  >     return observable((emit) => {
  >       ee.on("userUpdate", (data) => emit.next(data));
  >       return () => ee.off("userUpdate", handler);
  >     });
  >   }),
  > });
  >
  > const client = createTRPCProxyClient<typeof appRouter>({
  >   links: [
  >     splitLink({
  >       condition: (op) => op.type === "subscription",
  >       true: wsLink({ client: wsClient }),
  >       false: httpBatchLink({ url: "/trpc" }),
  >     }),
  >   ],
  > });
  > ```
- **Expected issues to identify:**
  1. `observable()` with `emit.next()` — deprecated, use `async function*` with `yield`
  2. Return-based teardown — use `opts.signal` (AbortSignal) cleanup
  3. `wsLink` for subscriptions — replace with `httpSubscriptionLink` (SSE)
  4. `createWSClient` — no longer needed with SSE transport
  5. `createTRPCProxyClient` — renamed to `createTRPCClient`
  6. `@trpc/server/observable` import — deprecated
- **Rubric:**
  | Criterion | Weight | Description |
  | --- | --- | --- |
  | `identify_observable_deprecation` | 25% | Observable → async generator |
  | `identify_teardown_change` | 15% | Return teardown → AbortSignal |
  | `identify_sse_migration` | 20% | wsLink → httpSubscriptionLink |
  | `identify_client_rename` | 10% | createTRPCProxyClient → createTRPCClient |
  | `identify_observable_import` | 10% | Import deprecated |
  | `correct_replacements` | 20% | Correct v11 subscription code |

---

**Task B2-ZD-2: Audit Zod v3 Function/Refinement Code for v4 Migration**

- **ID:** `zod-4-audit-v3-functions`
- **Prompt:**
  > This project is upgrading from **Zod v3 to v4**. Audit the following code and identify every pattern that is broken, deprecated, or behaves differently in Zod v4.
  >
  > ```typescript
  > import { z } from 'zod';
  >
  > const addUser = z.function()
  >   .args(z.object({ name: z.string(), age: z.number().int() }))
  >   .returns(z.object({ id: z.string(), name: z.string() }));
  > type AddUserFn = z.infer<typeof addUser>;
  >
  > const coerceAge = z.coerce.number();
  > type AgeInput = z.input<typeof coerceAge>; // Expected: number
  >
  > const userSchema = z.object({ ... }).superRefine((val, ctx) => {
  >   ctx.addIssue({ ..., path: ctx.path.concat(['password']) });
  > });
  >
  > const nonEmptyString = z.unknown().refine(
  >   (val): val is string => typeof val === 'string' && val.length > 0,
  > );
  > type NonEmpty = z.infer<typeof nonEmptyString>; // Expected: string
  >
  > const formatted = result.error.format();
  > const flat = result.error.flatten();
  > const optName = z.ostring();
  > ```
- **Expected issues to identify:**
  1. `z.function().args().returns()` — redesigned to `z.function({ input, output })`
  2. `z.infer<typeof functionSchema>` — function validators no longer schemas
  3. `z.input<typeof z.coerce.number()>` = `unknown` now, not `number`
  4. `ctx.path` in `.superRefine()` — removed in v4
  5. Type predicate in `.refine()` — ignored in v4, no type narrowing
  6. `.format()` / `.flatten()` / `.formErrors` — deprecated, use `z.treeifyError()`
  7. `z.ostring()` / `z.onumber()` / `z.oboolean()` — removed in v4
- **Rubric:**
  | Criterion | Weight | Description |
  | --- | --- | --- |
  | `identify_function_api_redesign` | 20% | z.function() API changed |
  | `identify_coerce_input_type` | 10% | coerce input = unknown |
  | `identify_ctx_path_removal` | 15% | ctx.path removed |
  | `identify_type_predicate_ignored` | 15% | Type predicates ignored |
  | `identify_error_methods_deprecated` | 10% | format/flatten deprecated |
  | `identify_convenience_removal` | 10% | z.ostring etc. removed |
  | `correct_replacements` | 20% | Correct v4 alternatives |

---

## 5. Evaluation System

### 5.1 Layer 1: Automated Tests (60% of final score)

Each task has a `test_spec` defining assertions that are checked programmatically:

| Test Type          | What It Checks                                                  | Tool                                              |
| ------------------ | --------------------------------------------------------------- | ------------------------------------------------- |
| **AST Check**      | Correct imports, function calls, no banned APIs, await/no-await | `ts-morph` or `@babel/parser`                     |
| **Type Check**     | Code compiles against the pinned library version                | `tsc --noEmit` with version-pinned `package.json` |
| **Negative Check** | Banned APIs are NOT present (e.g., no `useId` in React 17 code) | AST walking                                       |

**Scoring:** `test_score = passed_assertions / total_assertions` (0.0 to 1.0)

### 5.2 Layer 2: LLM Judge with Structured Rubric (40% of final score)

Uses **Pointwise Rubric Evaluation** — the judge evaluates each criterion independently.

#### Judge Configuration

- **Judge model:** Claude Opus (stronger than the tested Sonnet)
- **Temperature:** 0.0
- **Runs:** 3x per task, majority vote per criterion
- **Grounding:** Judge prompt includes reference documentation and reference solution. Judge is explicitly instructed to NOT use its own knowledge.

#### Rubric Scoring

Each criterion is binary (PASS / FAIL). The judge must provide:

```json
{
  "criterion": "correct_api",
  "verdict": "PASS",
  "evidence": "Line 5: `const cookieStore = await cookies();`",
  "reasoning": "The code correctly awaits cookies() which is required in Next.js 15."
}
```

#### Judge Prompt Template

```
You are a code correctness evaluator. Judge ONLY based on the reference
documentation and reference solution provided below. Do NOT use your own
knowledge of the library.

## Task
{task.prompt}

## Target Library Version
{task.library} v{task.target_version}

## Reference Documentation (ground truth)
{reference_docs}

## Reference Solution
{task.reference_solution}

## Generated Code (to evaluate)
{generated_code}

## Rubric Criteria
{task.rubric.criteria}

## Known Hallucination Patterns (watch for these)
{task.common_hallucinations}

For EACH criterion, respond ONLY with this JSON structure:
{
  "criterion": "<name>",
  "verdict": "PASS" | "FAIL",
  "evidence": "<exact line(s) from generated code>",
  "reasoning": "<1-2 sentences>"
}

IMPORTANT: A method is "correct" ONLY if it appears in the reference
documentation above. If you cannot find it in the docs, mark as FAIL
even if you believe it exists from your own knowledge.
```

### 5.3 Combined Score

```
final_score = 0.6 * test_score + 0.4 * judge_score
```

### 5.4 Hallucination Classification

Every task output is classified into hallucination categories:

| Category            | Description                        | Example                           |
| ------------------- | ---------------------------------- | --------------------------------- |
| `invented_method`   | API method that doesn't exist      | `NextResponse.after()`            |
| `wrong_parameter`   | Correct method, wrong params       | `cookies({ secure: true })`       |
| `outdated_api`      | API from an older version          | `experimental_streamText` in v4   |
| `future_api`        | API from a newer version           | `await cookies()` in v13          |
| `wrong_import_path` | Correct API, wrong import          | `useActionState` from `react-dom` |
| `version_mismatch`  | Mixed APIs from different versions | `forwardRef` + `ref` as prop      |

---

## 6. Execution Protocol

### 6.1 Agent Setup

For each of the three conditions:

- **Baseline:** Claude Sonnet (`temperature=0.0`), no MCP servers.
- **Context7:** Claude Sonnet (`temperature=0.0`), Context7 MCP with `resolve-library-id` + `query-docs`.
- **Nia:** Claude Sonnet (`temperature=0.0`), Nia MCP with full toolset.

All conditions receive the **identical system prompt and task prompt**. The only variable is MCP tool availability.

### 6.2 Per-Task Execution

```
For each task T:
  For each condition C in [baseline, context7, nia]:
    Repeat 3 times (for statistical stability):
      1. Send task prompt to Claude Sonnet with condition C's MCP config
      2. Extract generated code from response
      3. Run automated test assertions -> test_score
      4. Run LLM judge (3x majority vote) -> judge_score
      5. Classify hallucinations
      6. Compute final_score = 0.6 * test_score + 0.4 * judge_score
```

### 6.3 Controls for Fairness

- **Same prompt** across all conditions (no mention of Nia/Context7 by name)
- **Same model and temperature** (Claude Sonnet, temp=0.0)
- **Version-pinned environments** (`package.json` with exact versions for type checking)
- **Randomized execution order** (don't always run baseline first)
- **No caching** between runs

---

## 7. Metrics and Reporting

### 7.1 Primary Metrics

| Metric                      | Description                                                       |
| --------------------------- | ----------------------------------------------------------------- |
| **Task Pass Rate**          | % of tasks with `final_score >= 0.8`                              |
| **Hallucination Rate**      | % of tasks with >= 1 hallucination of any type                    |
| **Version Compliance Rate** | % of tasks where code uses ONLY APIs valid for the target version |
| **Mean Combined Score**     | Average `final_score` across all tasks                            |

### 7.2 Breakdown Dimensions

- **By category:** Bleeding-edge vs. Version-locked-write vs. Version-locked-audit
- **By library:** Next.js vs. React vs. AI SDK vs. tRPC vs. Zod
- **By version direction:** Newer-than-training vs. Older-than-training
- **By hallucination type:** invented_method, wrong_parameter, outdated_api, future_api, etc.

### 7.3 Output Format

```
================================================================
                     NIA-BENCH RESULTS v1.0
================================================================
 Metric                    Baseline   Context7   Nia
----------------------------------------------------------------
 Task Pass Rate            XX.X%      XX.X%      XX.X%
 Hallucination Rate        XX.X%      XX.X%      XX.X%
 Version Compliance Rate   XX.X%      XX.X%      XX.X%
 Mean Combined Score       X.XX       X.XX       X.XX
================================================================
 CATEGORY A: BLEEDING EDGE
 Task Pass Rate            XX.X%      XX.X%      XX.X%
 Hallucination Rate        XX.X%      XX.X%      XX.X%
================================================================
 CATEGORY B1: VERSION-LOCKED WRITE
 Task Pass Rate            XX.X%      XX.X%      XX.X%
 Version Compliance Rate   XX.X%      XX.X%      XX.X%
================================================================
 CATEGORY B2: VERSION-LOCKED AUDIT
 Task Pass Rate            XX.X%      XX.X%      XX.X%
 Issues Identified Rate    XX.X%      XX.X%      XX.X%
================================================================
 PER LIBRARY
 Next.js                   X.XX       X.XX       X.XX
 React                     X.XX       X.XX       X.XX
 Vercel AI SDK             X.XX       X.XX       X.XX
 tRPC                      X.XX       X.XX       X.XX
 Zod                       X.XX       X.XX       X.XX
================================================================
```

---

## 9. Implementation Phases

| Phase                     | Deliverables                                                             | Estimated Effort |
| ------------------------- | ------------------------------------------------------------------------ | ---------------- |
| **Phase 1: Foundation**   | Project scaffolding, task JSON schema, 5 pilot tasks, basic AST checker  | 1 week           |
| **Phase 2: Agent Runner** | MCP integration for 3 conditions, Anthropic API wrapper, code extraction | 1 week           |
| **Phase 3: Evaluation**   | LLM judge with rubric, hallucination classifier, combined scorer         | 1 week           |
| **Phase 4: Full Tasks**   | All 40 tasks with reference solutions, test specs, and rubrics           | 1-2 weeks        |
| **Phase 5: Polish**       | Reporter, README, CI, full benchmark run, publish results                | 1 week           |

---

## 10. Task Summary

### By Category

| Category                     | Tasks  | Libraries Covered                                                        |
| ---------------------------- | ------ | ------------------------------------------------------------------------ |
| **A: Bleeding-Edge**         | 14     | Next.js 16 (3), React 19 (3), AI SDK 4-5 (3), tRPC 11 (3), Zod 4 (2)     |
| **B1: Version-Locked Write** | 14     | Next.js 13-15 (3), React 17-18 (3), AI SDK 3 (2), tRPC 10 (3), Zod 3 (3) |
| **B2: Version-Locked Audit** | 12     | Next.js (3), React (3), Zod (2), tRPC (2), AI SDK (2)                    |
| **Total**                    | **40** |                                                                          |

### By Library

| Library           | Cat A  | Cat B1 | Cat B2 | Total  |
| ----------------- | ------ | ------ | ------ | ------ |
| **Next.js**       | 3      | 3      | 3      | **9**  |
| **React**         | 3      | 3      | 3      | **9**  |
| **Vercel AI SDK** | 3      | 2      | 2      | **7**  |
| **tRPC**          | 3      | 3      | 2      | **8**  |
| **Zod**           | 2      | 3      | 2      | **7**  |
| **Total**         | **14** | **14** | **12** | **40** |
