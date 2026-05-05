<?php

declare(strict_types=1);

use Illuminate\Foundation\Application;
use Illuminate\Foundation\Configuration\Exceptions;
use Illuminate\Foundation\Configuration\Middleware;

return Application::configure(basePath: dirname(__DIR__))
    ->withRouting(
        web:      __DIR__.'/../routes/web.php',
        commands: __DIR__.'/../routes/console.php',
        health:   '/up',
    )
    ->withMiddleware(function (Middleware $middleware) {
        // Trust X-Forwarded-* only from peers on the docker bridge
        // private subnet. Panel is bound to 127.0.0.1:9000 on the
        // host (R1-2 partial fix) and reached either via SSH-local-
        // forward (peer = 127.0.0.1) or from another ct-net
        // container on the docker default bridge (peer in 172.16/12).
        // The wildcard `at: '*'` previously accepted X-Forwarded-*
        // from any peer — once a public reverse-proxy lands (the
        // deferred R1-1 / R1-2 architectural item), wildcard trust
        // would let any actor reaching the panel TCP socket spoof
        // the client IP for logging / rate-limit purposes.
        // (R2-3 in docs/audits/2026-05-04T06-31-58Z.md.)
        $middleware->trustProxies(at: ['127.0.0.1', '172.16.0.0/12'], headers:
            \Illuminate\Http\Request::HEADER_X_FORWARDED_FOR
            | \Illuminate\Http\Request::HEADER_X_FORWARDED_HOST
            | \Illuminate\Http\Request::HEADER_X_FORWARDED_PORT
            | \Illuminate\Http\Request::HEADER_X_FORWARDED_PROTO
            | \Illuminate\Http\Request::HEADER_X_FORWARDED_AWS_ELB,
        );
    })
    ->withExceptions(function (Exceptions $exceptions) {
        // Anti-censorship cover-site preservation (v0.0.14).
        //
        // Default Laravel rendering for an uncaught Throwable is a
        // 5xx HTML error page (or a stack-trace dump with
        // APP_DEBUG=true). Either is a wire-level distinguisher
        // between "this server runs Cool Tunnel" and "this is a
        // static website" — a censor's mass scanner that sees a
        // Symfony / Laravel error page knows exactly what it's
        // looking at, blacklists the IP, and the operator's users
        // in the censored region lose access.
        //
        // For PUBLIC routes (everything except `/admin/*`,
        // `/livewire/*`, `/up`) any uncaught exception now
        // re-renders FakeSiteController so the wire response is
        // byte-identical to a vanilla unknown-path probe. The
        // operator still sees the real exception in `Log::critical`
        // (stderr → `docker compose logs panel`) so debugging
        // isn't lost.
        //
        // /admin/* routes keep the default handler — they're
        // loopback-bound (127.0.0.1:9000:9000 in compose) and an
        // operator SSH-tunnelled into the panel needs the actual
        // 5xx + stack trace to debug.
        $exceptions->render(function (\Throwable $e, \Illuminate\Http\Request $request) {
            // Exact-or-prefix-with-trailing-slash match. A naive
            // `str_starts_with($path, 'admin')` would also match
            // future routes like `administrator/`, `admins/list`,
            // `admin-export/...` — silently losing the cover-site
            // protection on those paths. (v0.0.15 hardening of the
            // v0.0.14 exception handler.)
            $path = $request->path();
            $isAdminLike = $path === 'admin'    || str_starts_with($path, 'admin/')
                        || $path === 'livewire' || str_starts_with($path, 'livewire/')
                        || $path === 'up';
            if ($isAdminLike) {
                return null; // delegate to the default renderer
            }

            \Illuminate\Support\Facades\Log::critical('public.route.exception', [
                'path' => $path,
                'err'  => $e->getMessage(),
                'type' => get_class($e),
            ]);

            try {
                return (new \App\Http\Controllers\FakeSiteController())->show($request);
            } catch (\Throwable) {
                // Cover site itself couldn't render (DB down, no
                // FakeWebsite seeded, etc.). Emit a minimal 200
                // empty body — still better than a 5xx stack
                // trace; the cover invariant degrades gracefully.
                return response('', 200)
                    ->header('Content-Type', 'text/html; charset=utf-8');
            }
        });
    })->create();
