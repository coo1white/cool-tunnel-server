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
        // Default handler is fine. We don't want stack traces leaking
        // to the cover-site fallback path.
    })->create();
