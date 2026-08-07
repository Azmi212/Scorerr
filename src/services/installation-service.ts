import { randomUUID } from 'node:crypto';

import { and, desc, eq, isNull } from 'drizzle-orm';

import {
  buildWebhookPayload,
  classifyScorerrWebhook,
  findScorerrWebhook,
  parseNotifications,
  parseRadarrStatus,
} from '../adapters/radarr-adapter.js';
import { buildSeerrUpdate, instanceUrl, parseSeerrInstances } from '../adapters/seerr-adapter.js';
import { RadarrClient } from '../clients/radarr-client.js';
import { SeerrClient } from '../clients/seerr-client.js';
import { normalizeServiceUrl, type HttpClientOptions } from '../clients/http-client.js';
import type { AppConfig } from '../config/env.js';
import type { DatabaseContext } from '../database/client.js';
import {
  installationAuditLog,
  installationDiagnostics,
  installationOperations,
  installationProbeReports,
  installationSnapshots,
  managedResources,
  serviceConnections,
  webhookDeliveries,
} from '../database/schema.js';
import { safeError, sanitize, ServiceClientError } from '../security/redaction.js';
import { redactProbeData } from '../security/probe-redaction.js';
import type { SecretStore } from '../security/secret-store.js';
import { sha256 } from './fingerprint.js';

type Service = 'radarr' | 'seerr';
export interface ClientFactory {
  radarr: (baseUrl: string, apiKey: string) => RadarrClient;
  seerr: (baseUrl: string, apiKey: string) => SeerrClient;
}

interface StoredConnection {
  id: number;
  service: Service;
  baseUrl: string;
  secretRef: string;
}
interface SnapshotData {
  selectedSeerrRadarrId: number;
  originalPreventSearch: boolean;
  webhookPresent: boolean;
  webhookId?: number;
  callbackUrl: string;
}

export interface DiagnosticResult {
  id?: number;
  status: 'ready' | 'selection_required' | 'blocked' | 'already_configured';
  callbackUrl: string | null;
  callbackWarning: string;
  radarr: {
    connected: boolean;
    version: string;
    instanceName?: string;
    webhookPresent: boolean;
    webhookState: import('../adapters/radarr-adapter.js').WebhookState;
  };
  seerr: {
    connected: boolean;
    version: string | null;
    radarrInstanceFound: boolean;
    selectedRadarrId: number | null;
    preventSearch: boolean | null;
    instances: { id: number; name: string; url: string }[];
  };
  changesRequired: {
    id: string;
    service: Service;
    current?: boolean;
    desired?: boolean;
    description: string;
  }[];
  ready: boolean;
  expiresAt?: string;
}

interface ProbeEndpointResult {
  available: boolean;
  status: 'ok' | 'not_found' | 'error';
  data: unknown;
  error?: { code: string; message: string };
}

export class InstallationService {
  private readonly clients: ClientFactory;
  constructor(
    private readonly database: DatabaseContext,
    private readonly config: AppConfig,
    private readonly secrets: SecretStore,
    clients?: ClientFactory,
  ) {
    const options: HttpClientOptions = {
      timeoutMs: config.HTTP_TIMEOUT_MS,
      maxResponseBytes: config.HTTP_MAX_RESPONSE_BYTES,
    };
    this.clients = clients ?? {
      radarr: (url, key) => new RadarrClient(url, key, options),
      seerr: (url, key) => new SeerrClient(url, key, options),
    };
  }

  async testConnection(
    service: Service,
    baseUrlInput: string,
    apiKey: string,
  ): Promise<Record<string, unknown>> {
    const baseUrl = normalizeServiceUrl(baseUrlInput);
    const now = new Date();
    try {
      let version: string | null = null;
      let instanceName: string | null = null;
      if (service === 'radarr') {
        const status = parseRadarrStatus(await this.clients.radarr(baseUrl, apiKey).status());
        version = status.version;
        instanceName = status.instanceName ?? null;
      } else {
        parseSeerrInstances(await this.clients.seerr(baseUrl, apiKey).radarrSettings());
        try {
          const publicSettings = await this.clients.seerr(baseUrl, apiKey).publicSettings();
          if (
            publicSettings &&
            typeof publicSettings === 'object' &&
            typeof (publicSettings as Record<string, unknown>).version === 'string'
          )
            version = (publicSettings as { version: string }).version;
        } catch {
          version = null;
        }
      }
      const existing = this.database.db
        .select()
        .from(serviceConnections)
        .where(
          and(eq(serviceConnections.service, service), eq(serviceConnections.baseUrl, baseUrl)),
        )
        .get();
      const secretRef = this.secrets.put(apiKey, existing?.secretRef);
      this.database.sqlite.transaction(() => {
        this.database.db
          .update(serviceConnections)
          .set({ isActive: false, updatedAt: now })
          .where(eq(serviceConnections.service, service))
          .run();
        if (existing)
          this.database.db
            .update(serviceConnections)
            .set({
              secretRef,
              isActive: true,
              connectionStatus: 'connected',
              version,
              instanceName,
              lastTestedAt: now,
              lastSuccessfulTestAt: now,
              updatedAt: now,
            })
            .where(eq(serviceConnections.id, existing.id))
            .run();
        else
          this.database.db
            .insert(serviceConnections)
            .values({
              service,
              alias: 'default',
              baseUrl,
              secretRef,
              isActive: true,
              connectionStatus: 'connected',
              version,
              instanceName,
              lastTestedAt: now,
              lastSuccessfulTestAt: now,
              createdAt: now,
              updatedAt: now,
            })
            .run();
      })();
      return sanitize({
        connected: true,
        service,
        baseUrl,
        version,
        instanceName,
        lastSuccessfulTestAt: now.toISOString(),
      });
    } catch (error) {
      const safe = safeError(error);
      return { connected: false, service, baseUrl, status: safe.code, error: safe.message };
    }
  }

  async diagnostic(selectedId?: number): Promise<DiagnosticResult> {
    const radarrConnection = this.activeConnection('radarr');
    const seerrConnection = this.activeConnection('seerr');
    if (!radarrConnection || !seerrConnection)
      throw new ServiceClientError(
        'incompatible_response',
        'Both active service connections are required',
      );
    const callbackUrl = this.callbackUrl();
    const radarr = this.clients.radarr(
      radarrConnection.baseUrl,
      this.secrets.get(radarrConnection.secretRef),
    );
    const seerr = this.clients.seerr(
      seerrConnection.baseUrl,
      this.secrets.get(seerrConnection.secretRef),
    );
    const status = parseRadarrStatus(await radarr.status());
    const notifications = parseNotifications(await radarr.notifications());
    const instances = parseSeerrInstances(await seerr.radarrSettings());
    const automaticMatches = instances.filter((item) =>
      this.urlsMatch(instanceUrl(item), radarrConnection.baseUrl),
    );
    const selected =
      selectedId === undefined
        ? automaticMatches.length === 1
          ? automaticMatches[0]
          : undefined
        : instances.find((item) => item.id === selectedId);
    if (selectedId !== undefined && !selected)
      throw new ServiceClientError(
        'incompatible_response',
        'Selected Seerr Radarr instance does not exist',
      );
    const classification = callbackUrl
      ? classifyScorerrWebhook(notifications, callbackUrl, this.managedNotificationIds())
      : { state: 'missing' as const, extraTriggers: [] };
    const webhook = [
      'managed_exact',
      'preexisting_exact',
      'preexisting_compatible_extra_triggers',
    ].includes(classification.state)
      ? classification.notification
      : undefined;
    const changes: DiagnosticResult['changesRequired'] = [];
    if (classification.state === 'conflict')
      changes.push({
        id: 'radarr-webhook-conflict',
        service: 'radarr',
        description: 'Résoudre le conflit de notification Radarr avant installation',
      });
    else if (!webhook)
      changes.push({
        id: 'radarr-create-webhook',
        service: 'radarr',
        description: 'Créer la notification MovieAdded vers scorerr',
      });
    if (selected && !selected.preventSearch)
      changes.push({
        id: 'seerr-disable-auto-search',
        service: 'seerr',
        current: false,
        desired: true,
        description: 'Laisser scorerr choisir la release avant le téléchargement',
      });
    const resultStatus: DiagnosticResult['status'] = !selected
      ? 'selection_required'
      : !callbackUrl
        ? 'blocked'
        : changes.length === 0
          ? 'already_configured'
          : 'ready';
    const createdAt = new Date();
    const expiresAt = new Date(createdAt.getTime() + this.config.SETUP_DIAGNOSTIC_TTL_MS);
    const result: DiagnosticResult = {
      status: resultStatus,
      callbackUrl,
      callbackWarning: 'Cette URL doit être accessible depuis le conteneur ou l’hôte Radarr.',
      radarr: {
        connected: true,
        version: status.version,
        ...(status.instanceName ? { instanceName: status.instanceName } : {}),
        webhookPresent: Boolean(webhook),
        webhookState: classification.state,
      },
      seerr: {
        connected: true,
        version: this.connectionVersion(seerrConnection.id),
        radarrInstanceFound: Boolean(selected),
        selectedRadarrId: selected?.id ?? null,
        preventSearch: selected?.preventSearch ?? null,
        instances: instances.map((item) => ({
          id: item.id,
          name: item.name,
          url: instanceUrl(item),
        })),
      },
      changesRequired: changes,
      ready: Boolean(selected && callbackUrl),
      expiresAt: expiresAt.toISOString(),
    };
    const fingerprint = sha256(
      JSON.stringify(
        sanitize({
          status,
          notifications,
          instances: instances.map((item) => ({ ...item, apiKey: undefined })),
        }),
      ),
    );
    const inserted = this.database.db
      .insert(installationDiagnostics)
      .values({
        status: resultStatus,
        radarrConnectionId: radarrConnection.id,
        seerrConnectionId: seerrConnection.id,
        selectedSeerrRadarrId: selected?.id,
        resultJson: JSON.stringify(result),
        configurationFingerprint: fingerprint,
        createdAt,
        expiresAt,
      })
      .run();
    result.id = Number(inserted.lastInsertRowid);
    return result;
  }

  async probe(): Promise<Record<string, unknown>> {
    if (this.config.SETUP_WRITES_ENABLED)
      throw new ServiceClientError(
        'writes_disabled',
        'The read-only probe requires SETUP_WRITES_ENABLED=false',
      );
    const radarrConnection = this.requireConnection('radarr');
    const seerrConnection = this.requireConnection('seerr');
    const radarr = this.clients.radarr(
      radarrConnection.baseUrl,
      this.secrets.get(radarrConnection.secretRef),
    );
    const seerr = this.clients.seerr(
      seerrConnection.baseUrl,
      this.secrets.get(seerrConnection.secretRef),
    );

    const [statusRaw, notificationsRaw, schemaResult, instancesRaw, publicRaw, seerrStatusRaw] =
      await Promise.all([
        radarr.status(),
        radarr.notifications(),
        this.optionalProbeGet(() => radarr.notificationSchemas()),
        seerr.radarrSettings(),
        seerr.publicSettings(),
        this.optionalProbeGet(() => seerr.status()),
      ]);
    const radarrStatus = parseRadarrStatus(statusRaw);
    const notifications = parseNotifications(notificationsRaw);
    const instances = parseSeerrInstances(instancesRaw);
    const matches = instances.filter((item) =>
      this.urlsMatch(instanceUrl(item), radarrConnection.baseUrl),
    );
    const selected = matches.length === 1 ? matches[0] : undefined;
    const publicRecord =
      publicRaw && typeof publicRaw === 'object' ? (publicRaw as Record<string, unknown>) : {};
    const seerrStatusRecord =
      seerrStatusRaw.data && typeof seerrStatusRaw.data === 'object'
        ? (seerrStatusRaw.data as Record<string, unknown>)
        : {};
    const seerrVersion =
      ['version', 'appVersion', 'commitTag']
        .map((key) => seerrStatusRecord[key] ?? publicRecord[key])
        .find((value): value is string => typeof value === 'string') ?? null;
    const movieAddedControls = [
      ...new Set(
        notifications.flatMap((item) =>
          Object.keys(item).filter((key) => key.toLowerCase().includes('movieadded')),
        ),
      ),
    ];
    const webhookNotifications = notifications.filter((item) => item.implementation === 'Webhook');
    const schemaArray: unknown[] = Array.isArray(schemaResult.data)
      ? (schemaResult.data as unknown[])
      : [];
    const webhookSchema =
      schemaArray.find((item) =>
        Boolean(
          item &&
          typeof item === 'object' &&
          (item as Record<string, unknown>).implementation === 'Webhook',
        ),
      ) ?? null;
    const redacted = redactProbeData({
      radarr: {
        status: statusRaw,
        notifications: notificationsRaw,
        notificationSchema: schemaResult.data,
      },
      seerr: {
        radarrSettings: instancesRaw,
        publicSettings: publicRaw,
        status: seerrStatusRaw.data,
      },
    });
    const readOnlyCandidates = [
      ...new Set(
        instances.flatMap((item) =>
          Object.keys(item).filter((key) =>
            /^(id|createdAt|updatedAt|status|isDefault)$/i.test(key),
          ),
        ),
      ),
    ];
    const modificationsRequired: string[] = [
      'Replace or extend mock fixtures with the captured redacted response shapes.',
      'Keep Seerr writes disabled until its exact writable PUT contract is validated separately.',
    ];
    if (!schemaResult.available)
      modificationsRequired.push(
        'Keep Radarr webhook creation unsupported for this version unless a validated provider contract is supplied.',
      );
    if (!movieAddedControls.includes('onMovieAdded'))
      modificationsRequired.push(
        'Adapt MovieAdded detection to the observed Radarr field before enabling writes.',
      );
    if (!instances.every((item) => typeof item.preventSearch === 'boolean'))
      modificationsRequired.push('Adapt preventSearch parsing to the observed Seerr contract.');

    const report = {
      probeVersion: 1,
      mode: 'read_only',
      writesEnabled: false,
      generatedAt: new Date().toISOString(),
      callsPerformed: [
        'GET Radarr /api/v3/system/status',
        'GET Radarr /api/v3/notification',
        'GET Radarr /api/v3/notification/schema',
        'GET Seerr /api/v1/settings/radarr',
        'GET Seerr /api/v1/settings/public',
        'GET Seerr /api/v1/status',
      ],
      radarr: {
        version: radarrStatus.version,
        instanceName: radarrStatus.instanceName ?? null,
        notificationCount: notifications.length,
        notificationTopLevelFields: [
          ...new Set(notifications.flatMap((item) => Object.keys(item))),
        ].sort(),
        implementations: [
          ...new Set(notifications.map((item) => item.implementation ?? 'unknown')),
        ].sort(),
        webhookNotificationCount: webhookNotifications.length,
        movieAddedControls,
        webhookSchemaEndpoint: {
          available: schemaResult.available,
          status: schemaResult.status,
          error: schemaResult.error ?? null,
        },
        webhookSchemaObserved: webhookSchema,
        notificationTestEndpoint: 'not_probed_no_authorized_safe_get_contract',
      },
      seerr: {
        version: seerrVersion,
        statusEndpoint: {
          available: seerrStatusRaw.available,
          status: seerrStatusRaw.status,
          error: seerrStatusRaw.error ?? null,
        },
        radarrInstanceCount: instances.length,
        instanceFields: [...new Set(instances.flatMap((item) => Object.keys(item)))].sort(),
        preventSearch: selected?.preventSearch ?? null,
        preventSearchTypes: [...new Set(instances.map((item) => typeof item.preventSearch))],
        possibleReadOnlyFields: readOnlyCandidates,
      },
      association: {
        matched: Boolean(selected),
        certain: matches.length === 1,
        method: 'normalized_url_exact_match',
        matchCount: matches.length,
        selectedSeerrRadarrId: selected?.id ?? null,
        selectedSeerrRadarrName: selected?.name ?? null,
      },
      sensitiveData: {
        detected: redacted.sensitiveFields.length > 0,
        redactedFields: redacted.sensitiveFields,
      },
      rawRedacted: redacted.value,
      compatibility: {
        mockDifferences: {
          expectedRadarrMovieAddedField: 'onMovieAdded',
          observedRadarrMovieAddedFields: movieAddedControls,
          expectedWebhookImplementation: 'Webhook',
          webhookSchemaAvailable: schemaResult.available,
          expectedSeerrPreventSearchType: 'boolean',
          observedSeerrPreventSearchTypes: [
            ...new Set(instances.map((item) => typeof item.preventSearch)),
          ],
        },
        uncertainFields: [
          'Seerr PUT writable versus read-only properties cannot be proven by GET responses alone.',
          'A safe Radarr notification test endpoint is not inferred or invoked.',
          'Radarr webhook creation payload remains unapproved until the observed schema is reviewed.',
        ],
        modificationsRequiredBeforeWrites: modificationsRequired,
      },
    };
    const inserted = this.database.db
      .insert(installationProbeReports)
      .values({
        reportJson: JSON.stringify(report),
        createdAt: new Date(),
      })
      .run();
    return { reportId: Number(inserted.lastInsertRowid), ...report };
  }

  async applyPreview(): Promise<Record<string, unknown>> {
    const radarrConnection = this.requireConnection('radarr');
    const seerrConnection = this.requireConnection('seerr');
    const callbackUrl = this.callbackUrl();
    if (!callbackUrl)
      throw new ServiceClientError('incompatible_response', 'SCORERR_PUBLIC_URL is required');
    const radarr = this.clients.radarr(
      radarrConnection.baseUrl,
      this.secrets.get(radarrConnection.secretRef),
    );
    const seerr = this.clients.seerr(
      seerrConnection.baseUrl,
      this.secrets.get(seerrConnection.secretRef),
    );
    const [notificationsRaw, schemasRaw, instancesRaw] = await Promise.all([
      radarr.notifications(),
      radarr.notificationSchemas(),
      seerr.radarrSettings(),
    ]);
    const notifications = parseNotifications(notificationsRaw);
    const classification = classifyScorerrWebhook(
      notifications,
      callbackUrl,
      this.managedNotificationIds(),
    );
    const instances = parseSeerrInstances(instancesRaw);
    const latestSelection = this.latestDiagnostic()?.selectedSeerrRadarrId;
    const matches = instances.filter((item) =>
      this.urlsMatch(instanceUrl(item), radarrConnection.baseUrl),
    );
    const selected =
      (latestSelection === null || latestSelection === undefined
        ? undefined
        : instances.find((item) => item.id === latestSelection)) ??
      (matches.length === 1 ? matches[0] : undefined);
    if (!selected)
      throw new ServiceClientError(
        'incompatible_response',
        'A single selected Seerr Radarr instance is required',
      );
    const radarrPayload = buildWebhookPayload(schemasRaw, callbackUrl);
    const seerrPayload = buildSeerrUpdate(selected, true);
    const radarrSkipped = classification.state !== 'missing';
    const seerrSkipped = selected.preventSearch;
    const redactedPayloads = redactProbeData({ radarr: radarrPayload, seerr: seerrPayload });
    return {
      mode: 'preview_only',
      writesEnabled: this.config.SETUP_WRITES_ENABLED,
      noRemoteWritesPerformed: true,
      endpoints: {
        radarr: `POST ${new URL('/api/v3/notification', `${radarrConnection.baseUrl}/`).toString()}`,
        seerr: `PUT ${new URL(`/api/v1/settings/radarr/${String(selected.id)}`, `${seerrConnection.baseUrl}/`).toString()}`,
      },
      operationOrder: [
        'radarr-create-webhook-if-missing',
        'radarr-read-and-verify',
        'seerr-set-preventSearch-true-if-needed',
        'seerr-read-and-verify',
      ],
      changes: [
        {
          id: 'radarr-create-webhook',
          status: radarrSkipped ? 'skipped' : 'planned',
          reason: radarrSkipped ? classification.state : 'missing',
          extraTriggers: classification.extraTriggers,
        },
        {
          id: 'seerr-disable-auto-search',
          status: seerrSkipped ? 'skipped' : 'planned',
          current: selected.preventSearch,
          desired: true,
        },
      ],
      payloads: redactedPayloads.value,
      redactedFields: redactedPayloads.sensitiveFields,
    };
  }

  async testWebhook(): Promise<Record<string, unknown>> {
    if (!this.config.SETUP_NON_PERSISTENT_TESTS_ENABLED)
      throw new ServiceClientError(
        'non_persistent_tests_disabled',
        'Non-persistent Radarr notification tests are disabled',
      );
    const connection = this.requireConnection('radarr');
    const callbackUrl = this.callbackUrl();
    if (!callbackUrl)
      throw new ServiceClientError('incompatible_response', 'SCORERR_PUBLIC_URL is required');
    const radarr = this.clients.radarr(connection.baseUrl, this.secrets.get(connection.secretRef));
    const payload = buildWebhookPayload(await radarr.notificationSchemas(), callbackUrl);
    const startedAt = Date.now();
    const baseline = this.database.db
      .select({ id: webhookDeliveries.id })
      .from(webhookDeliveries)
      .orderBy(desc(webhookDeliveries.id))
      .get();
    const response = await radarr.testNotification(payload);
    const deadline = Date.now() + this.config.HTTP_TIMEOUT_MS;
    while (Date.now() < deadline) {
      const received = this.database.sqlite
        .prepare(
          "SELECT id, event_id AS eventId, duplicate, received_at AS receivedAt FROM webhook_deliveries WHERE id > ? AND received_at >= ? AND event_type = 'Test' ORDER BY id DESC LIMIT 1",
        )
        .get(baseline?.id ?? 0, startedAt) as
        { id: number; eventId: number; duplicate: number; receivedAt: number } | undefined;
      if (received) {
        return {
          delivered: true,
          deliveryId: received.id,
          eventId: received.eventId,
          duplicate: received.duplicate === 1,
          receivedAt: new Date(received.receivedAt).toISOString(),
          radarrResponse: redactProbeData(response).value,
        };
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    return {
      delivered: false,
      error: 'Radarr accepted the test but no Test webhook was received before timeout',
    };
  }

  createSnapshot(): { snapshotId: number; reused: boolean } {
    const existing = this.database.db
      .select()
      .from(installationSnapshots)
      .orderBy(desc(installationSnapshots.id))
      .all()
      .find((item) => ['valid', 'applied', 'conflicted'].includes(item.state));
    if (existing) return { snapshotId: existing.id, reused: true };
    const diagnostic = this.latestDiagnostic();
    if (
      !diagnostic ||
      diagnostic.expiresAt.getTime() < Date.now() ||
      diagnostic.selectedSeerrRadarrId === null
    )
      throw new ServiceClientError(
        'incompatible_response',
        'A recent ready diagnostic is required',
      );
    const result = JSON.parse(diagnostic.resultJson) as DiagnosticResult;
    if (!result.ready || !result.callbackUrl)
      throw new ServiceClientError('incompatible_response', 'Diagnostic is not ready');
    const snapshot: SnapshotData = {
      selectedSeerrRadarrId: diagnostic.selectedSeerrRadarrId,
      originalPreventSearch: result.seerr.preventSearch ?? false,
      webhookPresent: result.radarr.webhookPresent,
      callbackUrl: result.callbackUrl,
    };
    const inserted = this.database.db
      .insert(installationSnapshots)
      .values({
        diagnosticId: diagnostic.id,
        snapshotJson: JSON.stringify(snapshot),
        configurationFingerprint: diagnostic.configurationFingerprint,
        createdAt: new Date(),
      })
      .run();
    return { snapshotId: Number(inserted.lastInsertRowid), reused: false };
  }

  async apply(): Promise<Record<string, unknown>> {
    this.assertWritesEnabled();
    const operationId = this.startOperation('apply');
    try {
      const snapshotRow = this.latestSnapshot(true);
      const snapshot = JSON.parse(snapshotRow.snapshotJson) as SnapshotData;
      const radarrConnection = this.requireConnection('radarr');
      const seerrConnection = this.requireConnection('seerr');
      const radarr = this.clients.radarr(
        radarrConnection.baseUrl,
        this.secrets.get(radarrConnection.secretRef),
      );
      const seerr = this.clients.seerr(
        seerrConnection.baseUrl,
        this.secrets.get(seerrConnection.secretRef),
      );
      let notifications = parseNotifications(await radarr.notifications());
      const initialClassification = classifyScorerrWebhook(
        notifications,
        snapshot.callbackUrl,
        this.managedNotificationIds(),
      );
      if (initialClassification.state === 'conflict')
        throw new ServiceClientError(
          'incompatible_response',
          'Radarr webhook configuration conflicts with the desired scorerr webhook',
        );
      let webhook = initialClassification.notification;
      let webhookResult = 'already_configured';
      if (!webhook) {
        const payload = buildWebhookPayload(
          await radarr.notificationSchemas(),
          snapshot.callbackUrl,
        );
        await radarr.createNotification(payload);
        notifications = parseNotifications(await radarr.notifications());
        webhook = findScorerrWebhook(notifications, snapshot.callbackUrl);
        if (!webhook)
          throw new ServiceClientError(
            'incompatible_response',
            'Radarr webhook creation could not be verified',
          );
        this.database.db
          .insert(managedResources)
          .values({
            snapshotId: snapshotRow.id,
            service: 'radarr',
            resourceType: 'notification',
            externalId: String(webhook.id),
            marker: snapshot.callbackUrl,
            createdByScorerr: true,
            expectedStateJson: JSON.stringify(sanitize(webhook)),
            createdAt: new Date(),
          })
          .run();
        webhookResult = 'created';
        this.audit(operationId, 'create', 'radarr', 'notification', String(webhook.id), 'success');
      }
      const instances = parseSeerrInstances(await seerr.radarrSettings());
      const selected = instances.find((item) => item.id === snapshot.selectedSeerrRadarrId);
      if (!selected)
        throw new ServiceClientError(
          'incompatible_response',
          'Selected Seerr Radarr instance disappeared',
        );
      let seerrResult = 'already_configured';
      if (!selected.preventSearch) {
        await seerr.updateRadarr(selected.id, buildSeerrUpdate(selected, true));
        const verified = parseSeerrInstances(await seerr.radarrSettings()).find(
          (item) => item.id === selected.id,
        );
        if (!verified?.preventSearch)
          throw new ServiceClientError(
            'incompatible_response',
            'Seerr update could not be verified',
          );
        seerrResult = 'updated';
        this.audit(
          operationId,
          'update',
          'seerr',
          'radarr-instance',
          String(selected.id),
          'success',
        );
      }
      const report = {
        status: 'operational',
        webhook: webhookResult,
        seerr: seerrResult,
        notificationTest: 'not_supported_by_validated_contract',
      };
      this.database.db
        .update(installationSnapshots)
        .set({ state: 'applied', appliedAt: new Date() })
        .where(eq(installationSnapshots.id, snapshotRow.id))
        .run();
      this.completeOperation(operationId, 'success', report);
      return report;
    } catch (error) {
      const safe = safeError(error);
      this.completeOperation(operationId, 'failed', safe);
      throw error;
    }
  }

  async rollback(): Promise<Record<string, unknown>> {
    this.assertWritesEnabled();
    const operationId = this.startOperation('rollback');
    try {
      const snapshotRow = this.latestSnapshot(true);
      const snapshot = JSON.parse(snapshotRow.snapshotJson) as SnapshotData;
      const seerrConnection = this.requireConnection('seerr');
      const seerr = this.clients.seerr(
        seerrConnection.baseUrl,
        this.secrets.get(seerrConnection.secretRef),
      );
      const selected = parseSeerrInstances(await seerr.radarrSettings()).find(
        (item) => item.id === snapshot.selectedSeerrRadarrId,
      );
      if (!selected) return this.conflict(operationId, 'Seerr Radarr instance disappeared');
      if (!selected.preventSearch && selected.preventSearch !== snapshot.originalPreventSearch)
        return this.conflict(operationId, 'preventSearch was changed manually');
      if (selected.preventSearch !== snapshot.originalPreventSearch) {
        await seerr.updateRadarr(
          selected.id,
          buildSeerrUpdate(selected, snapshot.originalPreventSearch),
        );
        const verified = parseSeerrInstances(await seerr.radarrSettings()).find(
          (item) => item.id === selected.id,
        );
        if (verified?.preventSearch !== snapshot.originalPreventSearch)
          throw new ServiceClientError(
            'incompatible_response',
            'Seerr rollback could not be verified',
          );
        this.audit(
          operationId,
          'restore',
          'seerr',
          'radarr-instance',
          String(selected.id),
          'success',
        );
      }
      const resource = this.database.db
        .select()
        .from(managedResources)
        .where(
          and(
            eq(managedResources.snapshotId, snapshotRow.id),
            eq(managedResources.createdByScorerr, true),
            isNull(managedResources.removedAt),
          ),
        )
        .orderBy(desc(managedResources.id))
        .get();
      let webhookResult = 'not_owned';
      if (resource) {
        const radarrConnection = this.requireConnection('radarr');
        const radarr = this.clients.radarr(
          radarrConnection.baseUrl,
          this.secrets.get(radarrConnection.secretRef),
        );
        const notifications = parseNotifications(await radarr.notifications());
        const current = notifications.find((item) => item.id === Number(resource.externalId));
        if (!current) {
          webhookResult = 'already_removed';
        } else if (!findScorerrWebhook([current], resource.marker))
          return this.conflict(operationId, 'Owned Radarr notification was changed manually');
        else {
          await radarr.deleteNotification(current.id);
          const remaining = parseNotifications(await radarr.notifications());
          if (remaining.some((item) => item.id === current.id))
            throw new ServiceClientError(
              'incompatible_response',
              'Radarr notification deletion could not be verified',
            );
          webhookResult = 'removed';
          this.audit(
            operationId,
            'delete',
            'radarr',
            'notification',
            String(current.id),
            'success',
          );
        }
        this.database.db
          .update(managedResources)
          .set({ removedAt: new Date() })
          .where(eq(managedResources.id, resource.id))
          .run();
      }
      const report = { status: 'rolled_back', seerr: 'restored', webhook: webhookResult };
      this.database.db
        .update(installationSnapshots)
        .set({ state: 'rolled_back', rolledBackAt: new Date() })
        .where(eq(installationSnapshots.id, snapshotRow.id))
        .run();
      this.completeOperation(operationId, 'success', report);
      return report;
    } catch (error) {
      this.completeOperation(operationId, 'failed', safeError(error));
      throw error;
    }
  }

  status(): Record<string, unknown> {
    const snapshot = this.database.db
      .select()
      .from(installationSnapshots)
      .orderBy(desc(installationSnapshots.id))
      .get();
    return {
      writesEnabled: this.config.SETUP_WRITES_ENABLED,
      snapshotAvailable: Boolean(snapshot && snapshot.state !== 'rolled_back'),
      snapshotState: snapshot?.state ?? null,
      adminAuth: 'planned',
    };
  }
  private activeConnection(service: Service): StoredConnection | undefined {
    return this.database.db
      .select({
        id: serviceConnections.id,
        service: serviceConnections.service,
        baseUrl: serviceConnections.baseUrl,
        secretRef: serviceConnections.secretRef,
      })
      .from(serviceConnections)
      .where(and(eq(serviceConnections.service, service), eq(serviceConnections.isActive, true)))
      .orderBy(desc(serviceConnections.id))
      .get();
  }
  private requireConnection(service: Service): StoredConnection {
    const value = this.activeConnection(service);
    if (!value)
      throw new ServiceClientError(
        'incompatible_response',
        `Active ${service} connection is required`,
      );
    return value;
  }
  private connectionVersion(id: number): string | null {
    return (
      this.database.db
        .select({ version: serviceConnections.version })
        .from(serviceConnections)
        .where(eq(serviceConnections.id, id))
        .get()?.version ?? null
    );
  }
  private managedNotificationIds(): Set<number> {
    return new Set(
      this.database.db
        .select({ externalId: managedResources.externalId })
        .from(managedResources)
        .where(
          and(
            eq(managedResources.service, 'radarr'),
            eq(managedResources.resourceType, 'notification'),
            eq(managedResources.createdByScorerr, true),
            isNull(managedResources.removedAt),
          ),
        )
        .all()
        .map((item) => Number(item.externalId)),
    );
  }
  private async optionalProbeGet(request: () => Promise<unknown>): Promise<ProbeEndpointResult> {
    try {
      return { available: true, status: 'ok', data: await request() };
    } catch (error) {
      const safe = safeError(error);
      return {
        available: false,
        status: safe.code === 'not_found' ? 'not_found' : 'error',
        data: null,
        error: safe,
      };
    }
  }
  private callbackUrl(): string | null {
    if (!this.config.SCORERR_PUBLIC_URL) return null;
    const base = normalizeServiceUrl(this.config.SCORERR_PUBLIC_URL);
    return `${base}/api/webhooks/radarr`;
  }
  private urlsMatch(left: string, right: string): boolean {
    try {
      const a = new URL(left);
      const b = new URL(right);
      return (
        a.protocol === b.protocol &&
        a.hostname.toLowerCase() === b.hostname.toLowerCase() &&
        (a.port || (a.protocol === 'https:' ? '443' : '80')) ===
          (b.port || (b.protocol === 'https:' ? '443' : '80')) &&
        a.pathname.replace(/\/$/, '') === b.pathname.replace(/\/$/, '')
      );
    } catch {
      return false;
    }
  }
  private latestDiagnostic() {
    return this.database.db
      .select()
      .from(installationDiagnostics)
      .orderBy(desc(installationDiagnostics.id))
      .get();
  }
  private latestSnapshot(includeApplied = false) {
    const rows = this.database.db
      .select()
      .from(installationSnapshots)
      .orderBy(desc(installationSnapshots.id))
      .all();
    const row = rows.find((item) =>
      includeApplied
        ? ['valid', 'applied', 'conflicted'].includes(item.state)
        : item.state === 'valid',
    );
    if (!row)
      throw new ServiceClientError(
        'incompatible_response',
        'A valid installation snapshot is required',
      );
    return row;
  }
  private assertWritesEnabled(): void {
    if (!this.config.SETUP_WRITES_ENABLED)
      throw new ServiceClientError(
        'writes_disabled',
        'Setup writes remain disabled until the read-only probe is validated',
      );
  }
  private startOperation(action: string): string {
    const id = randomUUID();
    this.database.db
      .insert(installationOperations)
      .values({ id, action, status: 'running', createdAt: new Date() })
      .run();
    return id;
  }
  private completeOperation(id: string, status: string, report: unknown): void {
    this.database.db
      .update(installationOperations)
      .set({ status, reportJson: JSON.stringify(sanitize(report)), completedAt: new Date() })
      .where(eq(installationOperations.id, id))
      .run();
  }
  private audit(
    operationId: string,
    action: string,
    service: Service,
    resourceType: string,
    resourceId: string,
    result: string,
  ): void {
    this.database.db
      .insert(installationAuditLog)
      .values({
        operationId,
        action,
        service,
        resourceType,
        resourceId,
        result,
        createdAt: new Date(),
      })
      .run();
  }
  private conflict(operationId: string, message: string): Record<string, unknown> {
    const report = { status: 'manual_intervention_required', message };
    this.completeOperation(operationId, 'conflict', report);
    return report;
  }
}
