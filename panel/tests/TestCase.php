<?php

declare(strict_types=1);

namespace Tests;

use Illuminate\Foundation\Testing\TestCase as BaseTestCase;

// Base PHPUnit test case for the panel.
//
// Laravel 11 ships its own bootstrap shape — we extend the
// framework's BaseTestCase, which auto-resolves the application
// via `bootstrap/app.php`. No `CreatesApplication` trait needed
// (deprecated since L11 — the application factory is built in).
//
// Subclass `TestCase` for any test that needs HTTP routing, the
// service container, or the DB. Pure-function tests can extend
// `\PHPUnit\Framework\TestCase` directly to avoid the framework
// boot cost.
//
// (v0.0.19 — Loop-5 self-check pass, panel/tests scaffold.)

abstract class TestCase extends BaseTestCase
{
}
