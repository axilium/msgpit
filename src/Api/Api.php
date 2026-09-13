<?php

declare(strict_types=1);

namespace Msgpit\Api;

use Msgpit\Core\DeliveryStatus;
use Msgpit\Core\Docs;
use Msgpit\Core\DlrDispatcher;
use Msgpit\Core\Message;
use Msgpit\Core\ProviderRegistry;
use Msgpit\Core\Scenario;
use Msgpit\Core\Storage;
use Msgpit\Core\SupportsDeliveryReports;
use Msgpit\Core\SupportsErrorScenarios;
use Msgpit\Http\Request;
use Msgpit\Http\Response;

/** The /api routes: the UI talks to these, and so do integration tests in consuming projects. */
final readonly class Api
{
    public function __construct(
        private Storage $storage,
        private ProviderRegistry $registry,
        private DlrDispatcher $dispatcher,
        private Docs $docs,
        private string $version = 'dev',
    ) {}

    public function handle(Request $request): ?Response
    {
        $path = rtrim(substr($request->path, strlen('/api')), '/');

        return match (true) {
            $request->method === 'GET' && $path === '/messages' => $this->list($request),
            $request->method === 'DELETE' && $path === '/messages' => $this->clear(),
            $request->method === 'POST' && $path === '/messages/read' => $this->markAllRead(),
            $request->method === 'GET' && $path === '/providers' => $this->providers(),
            $request->method === 'POST' && $path === '/scenario' => $this->scenario($request),
            $request->method === 'GET' && $path === '/scenarios' => $this->scenarios(),
            $request->method === 'GET' && $path === '/docs' => Response::json(['pages' => $this->docs->index()]),
            default => $this->messageRoutes($request, $path),
        };
    }

    private function messageRoutes(Request $request, string $path): ?Response
    {
        if (preg_match('#^/docs/([^/]+)$#', $path, $matches) === 1 && $request->method === 'GET') {
            $markdown = $this->docs->page($matches[1]);

            return $markdown === null
                ? Response::json(['error' => 'Page not found.'], 404)
                : Response::json(['slug' => $matches[1], 'markdown' => $markdown]);
        }

        if (preg_match('#^/messages/([^/]+)$#', $path, $matches) === 1 && $request->method === 'GET') {
            return $this->detail($matches[1]);
        }

        if (preg_match('#^/messages/([^/]+)/dlr$#', $path, $matches) === 1 && $request->method === 'POST') {
            return $this->sendDeliveryReport($matches[1], $request);
        }

        if (preg_match('#^/messages/([^/]+)/read$#', $path, $matches) === 1 && $request->method === 'POST') {
            $this->storage->markRead($matches[1]);

            return Response::json(['unread' => $this->storage->unreadCount()]);
        }

        return null;
    }

    private function list(Request $request): Response
    {
        /** @var array{provider?: string, channel?: string, to?: string, since?: string} $filters */
        $filters = array_intersect_key($request->query, array_flip(['provider', 'channel', 'to', 'since']));

        $messages = array_map(static fn (Message $message): array => $message->toArray(), $this->storage->all($filters));

        return Response::json(['messages' => $messages, 'unread' => $this->storage->unreadCount()]);
    }

    private function detail(string $id): Response
    {
        $message = $this->storage->find($id);

        if ($message === null) {
            return Response::json(['error' => 'Message not found.'], 404);
        }

        return Response::json($message->toArray() + [
            'rawRequest' => $this->storage->rawRequest($id),
            'deliveryReports' => $this->storage->deliveryReports($id),
        ]);
    }

    private function markAllRead(): Response
    {
        $this->storage->markAllRead();

        return Response::json(['unread' => 0]);
    }

    private function clear(): Response
    {
        $this->storage->clear();

        return Response::noContent();
    }

    private function providers(): Response
    {
        $providers = array_map(static fn ($provider): array => [
            'id' => $provider->id(),
            'channels' => array_map(static fn ($channel): string => $channel->value, $provider->channels()),
            'deliveryReports' => $provider instanceof SupportsDeliveryReports,
            'errorScenarios' => $provider instanceof SupportsErrorScenarios,
        ], $this->registry->all());

        return Response::json(['providers' => $providers, 'version' => $this->version]);
    }

    /** The catalogue the reference docs render, so the magic numbers are never copied by hand. */
    private function scenarios(): Response
    {
        $scenarios = array_map(static fn (Scenario $scenario): array => [
            'scenario' => $scenario->value,
            'recipient' => $scenario->recipient(),
            'description' => $scenario->description(),
        ], Scenario::cases());

        return Response::json(['scenarios' => $scenarios]);
    }

    private function scenario(Request $request): Response
    {
        $value = $request->json()['scenario'] ?? null;
        $scenario = is_string($value) ? Scenario::tryFrom($value) : null;

        if (is_string($value) && $value !== '' && $scenario === null) {
            return Response::json(['error' => 'Unknown scenario.'], 400);
        }

        $this->storage->setScenario($scenario);

        return Response::json(['scenario' => $scenario?->value]);
    }

    private function sendDeliveryReport(string $id, Request $request): Response
    {
        $message = $this->storage->find($id);

        if ($message === null) {
            return Response::json(['error' => 'Message not found.'], 404);
        }

        $value = $request->json()['status'] ?? null;
        $status = is_string($value) ? DeliveryStatus::tryFrom($value) : null;

        if ($status === null) {
            return Response::json(['error' => "Status must be 'delivered' or 'failed'."], 400);
        }

        $provider = $this->registry->get($message->provider);
        $callback = $provider instanceof SupportsDeliveryReports
            ? $provider->deliveryReport($message, $status)
            : null;

        $this->dispatcher->dispatch($id, $status, $callback);

        return Response::json([
            'status' => $status->value,
            'callbackSent' => $callback !== null,
            'deliveryReports' => $this->storage->deliveryReports($id),
        ]);
    }
}
