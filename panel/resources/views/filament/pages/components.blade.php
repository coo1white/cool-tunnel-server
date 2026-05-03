<x-filament-panels::page>
    <div class="grid grid-cols-1 sm:grid-cols-3 gap-4 mb-6">
        <x-filament::section>
            <div class="text-2xl font-bold {{ $summary['ok'] > 0 ? 'text-success-600' : 'text-gray-400' }}">
                {{ $summary['ok'] }}
            </div>
            <div class="text-sm text-gray-500">OK</div>
        </x-filament::section>
        <x-filament::section>
            <div class="text-2xl font-bold {{ $summary['ng'] > 0 ? 'text-danger-600' : 'text-gray-400' }}">
                {{ $summary['ng'] }}
            </div>
            <div class="text-sm text-gray-500">NG</div>
        </x-filament::section>
        <x-filament::section>
            <div class="text-2xl font-bold">{{ $summary['total'] }}</div>
            <div class="text-sm text-gray-500">Total</div>
        </x-filament::section>
    </div>

    <x-filament::section>
        <div class="overflow-x-auto">
            <table class="w-full text-sm" aria-label="Component check results">
                <caption class="sr-only">
                    Pinned versus installed versions of every component in the stack, with diagnostic message per row.
                </caption>
                <thead>
                    <tr class="border-b border-gray-200 dark:border-gray-700 text-left text-gray-500">
                        <th scope="col" class="px-3 py-2">Status</th>
                        <th scope="col" class="px-3 py-2">Component</th>
                        <th scope="col" class="px-3 py-2">Pinned</th>
                        <th scope="col" class="px-3 py-2">Installed</th>
                        <th scope="col" class="px-3 py-2">Diagnostic</th>
                    </tr>
                </thead>
                <tbody>
                @forelse ($rows as $row)
                    @php
                        $state = $row['state'] ?? 'unknown';
                        $isOk  = $state === 'ok';
                    @endphp
                    <tr class="border-b border-gray-100 dark:border-gray-800">
                        <td class="px-3 py-2">
                            <span
                                class="inline-block px-2 py-1 rounded text-xs font-semibold {{ $isOk ? 'bg-success-100 text-success-800 dark:bg-success-900/40 dark:text-success-300' : 'bg-danger-100 text-danger-800 dark:bg-danger-900/40 dark:text-danger-300' }}"
                                role="status"
                                aria-label="{{ $isOk ? 'OK' : 'Not OK' }}">
                                {{ $isOk ? 'OK' : 'NG' }}
                            </span>
                        </td>
                        <td class="px-3 py-2 font-mono break-all">{{ $row['name'] ?? '?' }}</td>
                        <td class="px-3 py-2 font-mono whitespace-nowrap">{{ $row['pinned_version'] ?? '' }}</td>
                        <td class="px-3 py-2 font-mono text-gray-600 dark:text-gray-400 whitespace-nowrap">{{ $row['installed_version'] ?? '—' }}</td>
                        <td class="px-3 py-2 text-gray-600 dark:text-gray-400">{{ $row['message'] ?? '' }}</td>
                    </tr>
                @empty
                    <tr>
                        <td colspan="5" class="px-3 py-6 text-center text-gray-500">
                            No components found. Make sure <code>manifests/</code> is mounted into the panel container at <code>/srv/manifests</code>.
                        </td>
                    </tr>
                @endforelse
                </tbody>
            </table>
        </div>
    </x-filament::section>

    <p class="text-sm text-gray-500 mt-4">
        These are the swappable parts of your stack. See
        <code>docs/components.md</code> for how to update each one.
    </p>
</x-filament-panels::page>
