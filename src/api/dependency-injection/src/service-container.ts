// service-container.ts - Core dependency injection container implementation
import crypto from "node:crypto";
import {
  ServiceContainer,
  ScopedContainer,
  ServiceRegistration,
  ServiceFactory,
  ServiceContext,
  ServiceLifetime,
  DependencyGraph,
  DependencyNode,
  ContainerStatistics,
  ContainerEvent,
  ContainerEventData,
  ContainerEventListener,
  DIConfiguration,
} from "./di-types";
import { AsyncLocalStorage } from "node:async_hooks";

/**
 * Per-resolution context shared across the async call-tree of a single
 * top-level resolve(). Threaded via AsyncLocalStorage so that dependencies
 * resolved *inside* a factory (container.resolve(...) calls) participate in the
 * same circular-dependency guard and depth limit as declared dependencies.
 * Without this, a cycle formed purely through factory self-resolution bypassed
 * the guard and recursed until a native RangeError (stack overflow).
 */
interface ResolutionContext {
  resolving: Set<string>;
  chain: string[];
}

const resolutionStore = new AsyncLocalStorage<ResolutionContext>();

/**
 * Run `fn` inside a resolution context. Nested (factory-initiated) resolves
 * reuse the in-flight context; a fresh top-level resolve starts a new one.
 */
function withResolutionContext<T>(fn: () => Promise<T>): Promise<T> {
  const existing = resolutionStore.getStore();
  if (existing) {
    return fn();
  }
  return resolutionStore.run({ resolving: new Set<string>(), chain: [] }, fn);
}

/**
 * Finalize a freshly-created service instance: resolve any Promise-valued
 * fields the factory returned, then invoke initialize() if present. Shared by
 * the singleton/transient path and the scoped path so every lifetime gets
 * identical post-construction handling (scoped services previously got neither).
 */
async function finalizeInstance<T>(raw: unknown): Promise<T> {
  let instance: unknown = raw;

  if (instance && typeof instance === "object" && !Array.isArray(instance)) {
    const entries = Object.entries(instance);
    if (entries.some(([, v]) => v && typeof (v as Promise<unknown>).then === "function")) {
      const resolvedEntries = await Promise.all(
        entries.map(async ([k, v]) => {
          if (v && typeof (v as Promise<unknown>).then === "function") {
            return [k, await (v as Promise<unknown>)] as const;
          }
          return [k, v] as const;
        })
      );
      instance = Object.fromEntries(resolvedEntries);
    }
  }

  const withInit = instance as { initialize?: () => Promise<void> };
  if (withInit && typeof withInit.initialize === "function") {
    await withInit.initialize();
  }

  return instance as T;
}

/**
 * Canonical key for a cycle: rotate so the lexicographically-smallest member is
 * first, so the same cycle discovered from different entry points dedupes.
 */
function canonicalCycleKey(cycle: string[]): string {
  if (cycle.length === 0) return "";
  let min = 0;
  for (let i = 1; i < cycle.length; i++) {
    if (cycle[i] < cycle[min]) min = i;
  }
  return [...cycle.slice(min), ...cycle.slice(0, min)].join("->");
}

/**
 * Create a scoped-lifetime instance with the same cycle guard + finalization as
 * the root container. Participates in the active ResolutionContext when one
 * exists (established by withResolutionContext in ScopedContainer.resolve).
 */
async function createScopedInstance<T>(
  scope: ScopedContainer,
  registration: ServiceRegistration,
  context: ServiceContext | undefined,
  name: string
): Promise<T> {
  const store = resolutionStore.getStore();
  if (store?.resolving.has(name)) {
    throw new Error(`Circular dependency detected: ${[...store.chain, name].join(" -> ")}`);
  }
  store?.resolving.add(name);
  store?.chain.push(name);
  try {
    const raw = await registration.factory(scope, context);
    return await finalizeInstance<T>(raw);
  } finally {
    store?.resolving.delete(name);
    store?.chain.pop();
  }
}

/**
 * Core service container implementation
 * Provides comprehensive dependency injection with lifecycle management
 */
export class DefaultServiceContainer implements ServiceContainer {
  private registrations = new Map<string, ServiceRegistration>();
  private tagIndex = new Map<string, Set<string>>();
  private singletonInstances = new Map<string, unknown>();
  private pendingSingletons = new Map<string, Promise<unknown>>();
  private eventListeners = new Map<ContainerEvent, ContainerEventListener[]>();
  private statistics: ContainerStatistics;
  private configuration: DIConfiguration;
  private parent: ServiceContainer | null = null;
  private children: ServiceContainer[] = [];
  private disposed = false;

  constructor(configuration: DIConfiguration = {}, parent: ServiceContainer | null = null) {
    // Initialize configuration with defaults
    // Why: Provides sensible defaults while allowing customization
    this.configuration = {
      enableAutoRegistration: true,
      enableCircularDependencyDetection: true,
      enableLifecycleLogging: false,
      enablePerformanceTracking: true,
      maxResolutionDepth: 50,
      scopeTimeout: 30000, // 30 seconds
      ...configuration,
    };

    this.parent = parent;

    // Initialize statistics tracking
    // Why: Enables monitoring of container performance and usage
    this.statistics = {
      totalServices: 0,
      singletonServices: 0,
      scopedServices: 0,
      transientServices: 0,
      totalResolutions: 0,
      cacheHits: 0,
      averageResolutionTime: 0,
      activeScopes: 0,
      memoryUsage: {
        singletonInstances: 0,
        scopedInstances: 0,
        containerOverhead: 0,
      },
    };
  }

  /**
   * Register a service with full configuration
   * Core service registration method with comprehensive options
   */
  register<T>(registration: ServiceRegistration<T>): void {
    if (this.disposed) {
      throw new Error("Cannot register services on disposed container");
    }

    // Validate registration
    // Why: Ensure registration is valid before storing
    if (!registration.name) {
      throw new Error("Service registration must have a name");
    }

    if (!registration.factory) {
      throw new Error("Service registration must have a factory function");
    }

    if (this.registrations.has(registration.name)) {
      throw new Error(`Service '${registration.name}' is already registered`);
    }

    // Store registration (widen to unknown for storage; T is preserved at resolve<T>)
    this.registrations.set(registration.name, registration as ServiceRegistration<unknown>);

    // Maintain the tag index so resolveAll(tag) is O(k) instead of an O(n) scan.
    if (registration.tags) {
      for (const tag of registration.tags) {
        let names = this.tagIndex.get(tag);
        if (!names) {
          names = new Set<string>();
          this.tagIndex.set(tag, names);
        }
        names.add(registration.name);
      }
    }

    // Update statistics
    // Why: Track registration metrics for monitoring
    this.statistics.totalServices++;
    switch (registration.lifetime) {
      case ServiceLifetime.SINGLETON:
        this.statistics.singletonServices++;
        break;
      case ServiceLifetime.SCOPED:
        this.statistics.scopedServices++;
        break;
      case ServiceLifetime.TRANSIENT:
        this.statistics.transientServices++;
        break;
    }

    // Emit registration event
    // Why: Allow external systems to react to service registration
    this.emitEvent(ContainerEvent.SERVICE_REGISTERED, {
      serviceName: registration.name,
      lifetime: registration.lifetime,
      metadata: registration.metadata,
    });

    // Log registration if enabled
    if (this.configuration.enableLifecycleLogging) {
      console.warn(
        `[DI] Registered service '${registration.name}' with lifetime '${registration.lifetime}'`
      );
    }
  }

  /**
   * Register singleton service
   * Convenience method for singleton registration
   */
  registerSingleton<T>(name: string, factory: ServiceFactory<T>): void {
    this.register({
      name,
      factory,
      lifetime: ServiceLifetime.SINGLETON,
    });
  }

  /**
   * Register scoped service
   * Convenience method for scoped registration
   */
  registerScoped<T>(name: string, factory: ServiceFactory<T>): void {
    this.register({
      name,
      factory,
      lifetime: ServiceLifetime.SCOPED,
    });
  }

  /**
   * Register transient service
   * Convenience method for transient registration
   */
  registerTransient<T>(name: string, factory: ServiceFactory<T>): void {
    this.register({
      name,
      factory,
      lifetime: ServiceLifetime.TRANSIENT,
    });
  }

  /**
   * Resolve service by name
   * Core service resolution with dependency injection
   */
  async resolve<T>(name: string, context?: ServiceContext): Promise<T> {
    if (this.disposed) {
      throw new Error("Cannot resolve services from disposed container");
    }

    const startTime = performance.now();

    // Establish (or join) a resolution context so factory-initiated resolves
    // share one circular-dependency guard and depth counter with declared deps.
    return withResolutionContext(async () => {
      const store = resolutionStore.getStore()!;
      try {
        const result = await this.resolveInternal<T>(name, context, store.chain, store.resolving);

        // Update statistics
        // Why: Track resolution performance and usage patterns
        this.statistics.totalResolutions++;
        const resolutionTime = performance.now() - startTime;
        this.updateAverageResolutionTime(resolutionTime);

        // Emit resolution event
        this.emitEvent(ContainerEvent.SERVICE_RESOLVED, {
          serviceName: name,
          resolutionTime,
          context,
          metadata: { dependencyChain: [...store.chain] },
        });

        return result;
      } catch (error) {
        // Emit error event
        this.emitEvent(ContainerEvent.RESOLUTION_ERROR, {
          serviceName: name,
          error: error as Error,
          context,
          metadata: {},
        });

        throw error;
      }
    });
  }

  /**
   * Internal service resolution with circular dependency detection
   * Handles the actual resolution logic with safety checks
   */
  private async resolveInternal<T>(
    name: string,
    context: ServiceContext | undefined,
    dependencyChain: string[],
    resolving: Set<string>
  ): Promise<T> {
    // Check for circular dependencies
    // Why: Prevent infinite recursion and provide helpful error messages
    if (this.configuration.enableCircularDependencyDetection && resolving.has(name)) {
      const cycle = [...dependencyChain, name];
      this.emitEvent(ContainerEvent.CIRCULAR_DEPENDENCY, {
        serviceName: name,
        metadata: { cycle },
      });
      throw new Error(`Circular dependency detected: ${cycle.join(" -> ")}`);
    }

    // Check resolution depth
    // Why: Prevent stack overflow from deep dependency chains
    if (dependencyChain.length >= this.configuration.maxResolutionDepth!) {
      throw new Error(
        `Maximum resolution depth exceeded (${this.configuration.maxResolutionDepth})`
      );
    }

    // Get service registration
    const registration = this.getRegistration(name);
    if (!registration) {
      // Try parent container if available
      if (this.parent) {
        return await this.parent.resolve<T>(name, context);
      }
      throw new Error(`Service '${name}' is not registered`);
    }

    // Handle singleton lifetime
    // Why: Singletons should be created once and reused
    if (registration.lifetime === ServiceLifetime.SINGLETON) {
      if (this.singletonInstances.has(name)) {
        this.statistics.cacheHits++;
        return this.singletonInstances.get(name) as T;
      }

      // If another resolution is already creating this singleton, await it
      const pending = this.pendingSingletons.get(name);
      if (pending) {
        this.statistics.cacheHits++;
        return pending as unknown as T;
      }
    }

    // Add to resolving set and dependency chain
    resolving.add(name);
    dependencyChain.push(name);

    try {
      let instancePromise: Promise<T>;

      if (registration.lifetime === ServiceLifetime.SINGLETON) {
        // De-duplicate concurrent singleton creation
        instancePromise = this.createServiceInstance(
          registration as ServiceRegistration<T>,
          context,
          dependencyChain,
          resolving
        )
          .then((instance) => {
            this.singletonInstances.set(name, instance);
            this.pendingSingletons.delete(name);
            return instance;
          })
          .catch((err) => {
            this.pendingSingletons.delete(name);
            throw err;
          });

        this.pendingSingletons.set(name, instancePromise as unknown as Promise<unknown>);
      } else {
        instancePromise = this.createServiceInstance(
          registration as ServiceRegistration<T>,
          context,
          dependencyChain,
          resolving
        );
      }

      const instance = await instancePromise;
      return instance as T;
    } finally {
      // Clean up resolving state
      resolving.delete(name);
      dependencyChain.pop();
    }
  }

  /**
   * Create service instance with dependency injection
   * Handles factory invocation and dependency resolution
   */
  private async createServiceInstance<T = unknown>(
    registration: ServiceRegistration<T>,
    context: ServiceContext | undefined,
    dependencyChain: string[],
    resolving: Set<string>
  ): Promise<T> {
    // Resolve dependencies first
    // Why: Dependencies must be available before creating the service
    if (registration.dependencies && registration.dependencies.length > 0) {
      for (const depName of registration.dependencies) {
        await this.resolveInternal(depName, context, dependencyChain, resolving);
      }
    }

    // Create the instance via the factory, then finalize it (resolve any
    // Promise-valued fields and invoke initialize()). finalizeInstance is shared
    // with the scoped path so every lifetime gets identical handling.
    const raw = await registration.factory(this, context);
    return finalizeInstance<T>(raw);
  }

  /**
   * Resolve all services with a specific tag
   * Enables service discovery by tags
   */
  async resolveAll<T>(tag: string, context?: ServiceContext): Promise<T[]> {
    const services: T[] = [];

    // O(k) tag lookup via the tag index instead of an O(n) scan over every
    // registration. Set iteration preserves registration order.
    const names = this.tagIndex.get(tag);
    if (names) {
      for (const name of names) {
        services.push(await this.resolve<T>(name, context));
      }
    }

    return services;
  }

  /**
   * Try to resolve service without throwing on failure
   * Safe resolution that returns null if service not found
   */
  async tryResolve<T>(name: string, context?: ServiceContext): Promise<T | null> {
    try {
      return await this.resolve<T>(name, context);
    } catch {
      return null;
    }
  }

  /**
   * Check if service is registered
   * Quick check for service availability
   */
  isRegistered(name: string): boolean {
    return this.registrations.has(name) || (this.parent?.isRegistered(name) ?? false);
  }

  /**
   * Get service registration
   * Access to registration metadata
   */
  getRegistration(name: string): ServiceRegistration | undefined {
    return this.registrations.get(name) || this.parent?.getRegistration(name);
  }

  /**
   * Get all registrations
   * Access to all registered services
   */
  getAllRegistrations(): ServiceRegistration[] {
    const allRegistrations = Array.from(this.registrations.values());

    if (this.parent) {
      allRegistrations.push(...this.parent.getAllRegistrations());
    }

    return allRegistrations;
  }

  /**
   * Create scoped container
   * Creates a new scope for request-specific services
   */
  createScope(context?: ServiceContext): ScopedContainer {
    this.statistics.activeScopes++;

    const scopedContainer = new DefaultScopedContainer(
      this,
      context || {
        requestId: crypto.randomUUID(),
        startTime: Date.now(),
      },
      this.configuration.scopeTimeout ?? 30000
    );

    this.emitEvent(ContainerEvent.SCOPE_CREATED, {
      context,
      metadata: { scopeId: context?.requestId },
    });

    return scopedContainer;
  }

  /**
   * Create child container
   * Creates a hierarchical container for modular architecture
   */
  createChild(): ServiceContainer {
    const child = new DefaultServiceContainer(this.configuration, this);
    this.children.push(child);
    return child;
  }

  /**
   * Get parent container
   * Access to parent in container hierarchy
   */
  getParent(): ServiceContainer | null {
    return this.parent;
  }

  /**
   * Decrement the active-scope counter when a scope disposes.
   * @internal called by DefaultScopedContainer.disposeScope(). The scope
   * previously tried to decrement via getStatistics(), which returns a copy, so
   * the counter never went down — activeScopes leaked one per created scope
   * (i.e. one per HTTP request under the Fastify integration).
   */
  _notifyScopeDisposed(): void {
    this.statistics.activeScopes = Math.max(0, this.statistics.activeScopes - 1);
  }

  /**
   * Dispose container and all services
   * Cleanup all resources and singleton instances
   */
  async dispose(): Promise<void> {
    if (this.disposed) {
      return;
    }

    this.disposed = true;

    // Dispose all child containers
    // Why: Ensure proper cleanup of entire container hierarchy
    for (const child of this.children) {
      await child.dispose();
    }

    // Dispose singleton instances
    // Why: Allow services to clean up resources
    for (const [name, instance] of this.singletonInstances.entries()) {
      const registration = this.registrations.get(name);
      if (registration?.dispose && instance) {
        try {
          await registration.dispose(instance);
        } catch (error) {
          console.error(`Error disposing service '${name}':`, error);
        }
      }

      // Call dispose method if service has one
      const withDispose = instance as { dispose?: () => Promise<void> };
      if (withDispose && typeof withDispose.dispose === "function") {
        try {
          await withDispose.dispose();
        } catch (error) {
          console.error(`Error calling dispose on service '${name}':`, error);
        }
      }
    }

    // Clear all data
    this.registrations.clear();
    this.tagIndex.clear();
    this.singletonInstances.clear();
    this.pendingSingletons.clear();
    this.eventListeners.clear();
    this.children.length = 0;

    if (this.configuration.enableLifecycleLogging) {
      console.warn("[DI] Container disposed");
    }
  }

  /**
   * Add event listener
   * Subscribe to container events
   */
  addEventListener(event: ContainerEvent, listener: ContainerEventListener): void {
    if (!this.eventListeners.has(event)) {
      this.eventListeners.set(event, []);
    }
    this.eventListeners.get(event)!.push(listener);
  }

  /**
   * Remove event listener
   * Unsubscribe from container events
   */
  removeEventListener(event: ContainerEvent, listener: ContainerEventListener): void {
    const listeners = this.eventListeners.get(event);
    if (listeners) {
      const index = listeners.indexOf(listener);
      if (index >= 0) {
        listeners.splice(index, 1);
      }
    }
  }

  /**
   * Emit container event
   * Internal method to emit events to listeners
   */
  private emitEvent(event: ContainerEvent, data: ContainerEventData): void {
    const listeners = this.eventListeners.get(event);
    if (listeners) {
      for (const listener of listeners) {
        try {
          listener(event, data);
        } catch (error) {
          console.error(`Error in event listener for ${event}:`, error);
        }
      }
    }
  }

  /**
   * Get container statistics
   * Performance and usage metrics
   */
  getStatistics(): ContainerStatistics {
    return { ...this.statistics };
  }

  /**
   * Build dependency graph
   * Analyze service dependencies for visualization and debugging
   */
  buildDependencyGraph(): DependencyGraph {
    const nodes = new Map<string, DependencyNode>();
    const roots: string[] = [];
    const leaves: string[] = [];
    const cycles: string[][] = [];

    // Build nodes
    for (const registration of this.registrations.values()) {
      const node: DependencyNode = {
        name: registration.name,
        dependencies: registration.dependencies || [],
        dependents: [],
        registration,
        resolved: this.singletonInstances.has(registration.name),
        resolving: false,
      };
      nodes.set(registration.name, node);
    }

    // Build dependents
    for (const node of nodes.values()) {
      for (const depName of node.dependencies) {
        const depNode = nodes.get(depName);
        if (depNode) {
          depNode.dependents.push(node.name);
        }
      }
    }

    // Identify roots and leaves
    for (const node of nodes.values()) {
      if (node.dependencies.length === 0) {
        roots.push(node.name);
      }
      if (node.dependents.length === 0) {
        leaves.push(node.name);
      }
    }

    // Detect cycles with a 3-color DFS. Each distinct cycle is reported exactly
    // once (canonicalized), with no spurious prefix nodes — unlike the previous
    // shared-visited walk which duplicated cycles and prepended unrelated path
    // segments.
    this.collectCycles(nodes, cycles);

    return { nodes, roots, leaves, cycles };
  }

  /**
   * Collect every distinct dependency cycle via 3-color DFS.
   * GREY = on the current DFS stack, BLACK = fully explored. A back-edge to a
   * GREY node is a cycle; we slice it off the stack and canonicalize so the same
   * cycle reached from different roots is reported once.
   */
  private collectCycles(nodes: Map<string, DependencyNode>, cycles: string[][]): void {
    const GREY = 1;
    const BLACK = 2;
    const color = new Map<string, number>();
    const stack: string[] = [];
    const seen = new Set<string>();

    const visit = (name: string): void => {
      color.set(name, GREY);
      stack.push(name);

      const node = nodes.get(name);
      if (node) {
        for (const dep of node.dependencies) {
          if (!nodes.has(dep)) continue; // external/unregistered dependency
          const c = color.get(dep);
          if (c === GREY) {
            const idx = stack.indexOf(dep);
            const cycle = stack.slice(idx);
            const key = canonicalCycleKey(cycle);
            if (!seen.has(key)) {
              seen.add(key);
              cycles.push(cycle);
            }
          } else if (c !== BLACK) {
            visit(dep);
          }
        }
      }

      stack.pop();
      color.set(name, BLACK);
    };

    for (const name of nodes.keys()) {
      if (color.get(name) === undefined) {
        visit(name);
      }
    }
  }

  /**
   * Update average resolution time
   * Running average calculation for performance tracking
   */
  private updateAverageResolutionTime(newTime: number): void {
    const total = this.statistics.totalResolutions;
    const currentAvg = this.statistics.averageResolutionTime;

    this.statistics.averageResolutionTime = (currentAvg * (total - 1) + newTime) / total;
  }
}

/**
 * Scoped container implementation
 * Manages request-scoped services with automatic cleanup
 */
export class DefaultScopedContainer implements ScopedContainer {
  private parent: ServiceContainer;
  private context: ServiceContext;
  private scopedInstances = new Map<string, unknown>();
  private disposed = false;
  private disposeTimer?: NodeJS.Timeout;

  constructor(parent: ServiceContainer, context: ServiceContext, scopeTimeout = 30000) {
    this.parent = parent;
    this.context = context;

    // Set up automatic disposal timer honoring the configured scopeTimeout
    // (previously hardcoded 30s and gated on an unrelated activeScopes check, so
    // configuration.scopeTimeout was silently ignored). Skipped in test env to
    // avoid Jest open handles; unref()'d so an idle scope timer never keeps the
    // process alive on its own.
    const isTestEnv = process.env.NODE_ENV === "test" || process.env.JEST_WORKER_ID !== undefined;
    if (!isTestEnv && scopeTimeout > 0) {
      this.disposeTimer = setTimeout(() => {
        this.disposeScope().catch(console.error);
      }, scopeTimeout);
      if (typeof this.disposeTimer.unref === "function") {
        this.disposeTimer.unref();
      }
    }
  }

  // Delegate most methods to parent container
  register<T>(_registration: ServiceRegistration<T>): void {
    throw new Error("Cannot register services on scoped container");
  }

  registerSingleton<T>(_name: string, _factory: ServiceFactory<T>): void {
    throw new Error("Cannot register services on scoped container");
  }

  registerScoped<T>(_name: string, _factory: ServiceFactory<T>): void {
    throw new Error("Cannot register services on scoped container");
  }

  registerTransient<T>(_name: string, _factory: ServiceFactory<T>): void {
    throw new Error("Cannot register services on scoped container");
  }

  async resolve<T>(name: string, context?: ServiceContext): Promise<T> {
    if (this.disposed) {
      throw new Error("Cannot resolve services from disposed scope");
    }

    return withResolutionContext(async () => {
      const registration = this.parent.getRegistration(name);
      if (!registration) {
        return this.parent.resolve<T>(name, context || this.context);
      }

      // Handle scoped services with the same cycle guard and finalization
      // (Promise-field resolution + initialize()) as the root container, instead
      // of a bare factory() call that skipped both.
      if (registration.lifetime === ServiceLifetime.SCOPED) {
        if (this.scopedInstances.has(name)) {
          return this.scopedInstances.get(name) as T;
        }

        const instance = await createScopedInstance<T>(
          this,
          registration,
          context || this.context,
          name
        );
        this.scopedInstances.set(name, instance);
        return instance;
      }

      // Delegate to parent for non-scoped services (shares the active resolution
      // context so cross-scope cycles are detected too).
      return this.parent.resolve<T>(name, context || this.context);
    });
  }

  async resolveAll<T>(tag: string, context?: ServiceContext): Promise<T[]> {
    return this.parent.resolveAll<T>(tag, context || this.context);
  }

  async tryResolve<T>(name: string, context?: ServiceContext): Promise<T | null> {
    try {
      return await this.resolve<T>(name, context);
    } catch {
      return null;
    }
  }

  isRegistered(name: string): boolean {
    return this.parent.isRegistered(name);
  }

  getRegistration(name: string): ServiceRegistration | undefined {
    return this.parent.getRegistration(name);
  }

  getAllRegistrations(): ServiceRegistration[] {
    return this.parent.getAllRegistrations();
  }

  createScope(context?: ServiceContext): ScopedContainer {
    return this.parent.createScope(context || this.context);
  }

  createChild(): ServiceContainer {
    return this.parent.createChild();
  }

  getParent(): ServiceContainer | null {
    return this.parent;
  }

  getContext(): ServiceContext {
    return this.context;
  }

  async dispose(): Promise<void> {
    await this.disposeScope();
  }

  async disposeScope(): Promise<void> {
    if (this.disposed) {
      return;
    }

    this.disposed = true;

    // Clear dispose timer
    if (this.disposeTimer) {
      clearTimeout(this.disposeTimer);
    }

    // Dispose scoped instances
    for (const [name, instance] of this.scopedInstances.entries()) {
      const registration = this.parent.getRegistration(name);
      if (registration?.dispose && instance) {
        try {
          await registration.dispose(instance);
        } catch (error) {
          console.error(`Error disposing scoped service '${name}':`, error);
        }
      }

      const withDispose = instance as { dispose?: () => Promise<void> };
      if (withDispose && typeof withDispose.dispose === "function") {
        try {
          await withDispose.dispose();
        } catch (error) {
          console.error(`Error calling dispose on scoped service '${name}':`, error);
        }
      }
    }

    this.scopedInstances.clear();

    // Decrement the parent's active-scope counter via its own method. The
    // previous code mutated the copy returned by getStatistics(), so this never
    // took effect and activeScopes leaked upward on every scope disposal.
    const parent = this.parent as DefaultServiceContainer;
    if (typeof parent._notifyScopeDisposed === "function") {
      parent._notifyScopeDisposed();
    }
  }
}
