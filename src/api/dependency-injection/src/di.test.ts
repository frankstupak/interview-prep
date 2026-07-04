// di.test.ts - Comprehensive tests for dependency injection system
import { DefaultServiceContainer, DefaultScopedContainer } from "./service-container";
import { ServiceLifetime, ContainerEvent, DIConfiguration } from "./di-types";

describe("Dependency Injection System", () => {
  let container: DefaultServiceContainer;

  beforeEach(() => {
    container = new DefaultServiceContainer();
  });

  afterEach(async () => {
    await container.dispose();
    // Clear any timers that might be running
    jest.clearAllTimers();
    // Clear all mocks
    jest.clearAllMocks();
  });

  describe("Service Registration", () => {
    it("should register singleton service", () => {
      container.registerSingleton("testService", () => ({ value: "test" }));

      expect(container.isRegistered("testService")).toBe(true);

      const registration = container.getRegistration("testService");
      expect(registration?.name).toBe("testService");
      expect(registration?.lifetime).toBe(ServiceLifetime.SINGLETON);
    });

    it("should register scoped service", () => {
      container.registerScoped("scopedService", () => ({ id: Math.random() }));

      expect(container.isRegistered("scopedService")).toBe(true);

      const registration = container.getRegistration("scopedService");
      expect(registration?.lifetime).toBe(ServiceLifetime.SCOPED);
    });

    it("should register transient service", () => {
      container.registerTransient("transientService", () => ({ timestamp: Date.now() }));

      expect(container.isRegistered("transientService")).toBe(true);

      const registration = container.getRegistration("transientService");
      expect(registration?.lifetime).toBe(ServiceLifetime.TRANSIENT);
    });

    it("should throw error for duplicate registration", () => {
      container.registerSingleton("duplicate", () => ({}));

      expect(() => {
        container.registerSingleton("duplicate", () => ({}));
      }).toThrow("Service 'duplicate' is already registered");
    });

    it("should register service with dependencies", () => {
      container.registerSingleton("dependency", () => ({ value: "dep" }));
      container.register({
        name: "serviceWithDeps",
        factory: (c) => ({
          dep: c.resolve("dependency"),
          value: "main",
        }),
        lifetime: ServiceLifetime.SINGLETON,
        dependencies: ["dependency"],
      });

      expect(container.isRegistered("serviceWithDeps")).toBe(true);

      const registration = container.getRegistration("serviceWithDeps");
      expect(registration?.dependencies).toEqual(["dependency"]);
    });
  });

  describe("Service Resolution", () => {
    it("should resolve singleton service", async () => {
      const testValue = { value: "singleton-test" };
      container.registerSingleton("singleton", () => testValue);

      const resolved1 = await container.resolve("singleton");
      const resolved2 = await container.resolve("singleton");

      expect(resolved1).toBe(testValue);
      expect(resolved2).toBe(testValue);
      expect(resolved1).toBe(resolved2); // Same instance
    });

    it("should resolve transient service with new instances", async () => {
      container.registerTransient("transient", () => ({ id: Math.random() }));

      const resolved1 = await container.resolve<{ id: number }>("transient");
      const resolved2 = await container.resolve<{ id: number }>("transient");

      expect(resolved1).not.toBe(resolved2); // Different instances
      expect(resolved1.id).not.toBe(resolved2.id);
    });

    it("should resolve service with dependencies", async () => {
      container.registerSingleton("logger", () => ({ log: jest.fn() }));
      container.registerSingleton("config", () => ({ port: 3000 }));

      container.registerSingleton("app", (c) => ({
        logger: c.resolve("logger"),
        config: c.resolve("config"),
        name: "test-app",
      }));

      const app = await container.resolve<{
        name: string;
        logger: unknown;
        config: { port: number };
      }>("app");

      expect(app.name).toBe("test-app");
      expect(app.logger).toBeDefined();
      expect(app.config).toBeDefined();
      expect(app.config.port).toBe(3000);
    });

    it("should throw error for unregistered service", async () => {
      await expect(container.resolve("nonexistent")).rejects.toThrow(
        "Service 'nonexistent' is not registered"
      );
    });

    it("should return null for tryResolve with unregistered service", async () => {
      const result = await container.tryResolve("nonexistent");
      expect(result).toBeNull();
    });

    it("should resolve all services by tag", async () => {
      container.register({
        name: "handler1",
        factory: () => ({ type: "email" }),
        lifetime: ServiceLifetime.TRANSIENT,
        tags: ["handler"],
      });

      container.register({
        name: "handler2",
        factory: () => ({ type: "sms" }),
        lifetime: ServiceLifetime.TRANSIENT,
        tags: ["handler"],
      });

      const handlers = await container.resolveAll<{ type: string }>("handler");

      expect(handlers).toHaveLength(2);
      expect(handlers.map((h) => h.type)).toEqual(expect.arrayContaining(["email", "sms"]));
    });
  });

  describe("Scoped Container", () => {
    it("should create scoped container", () => {
      const scope = container.createScope();

      expect(scope).toBeInstanceOf(DefaultScopedContainer);
      expect(scope.getContext()).toBeDefined();
      expect(scope.getContext().requestId).toBeDefined();
    });

    it("should resolve scoped services within scope", async () => {
      container.registerScoped("scopedService", () => ({ id: Math.random() }));

      const scope = container.createScope();

      const service1 = await scope.resolve("scopedService");
      const service2 = await scope.resolve("scopedService");

      expect(service1).toBe(service2); // Same instance within scope

      await scope.disposeScope();
    });

    it("should create different instances in different scopes", async () => {
      container.registerScoped("scopedService", () => ({ id: Math.random() }));

      const scope1 = container.createScope();
      const scope2 = container.createScope();

      const service1 = await scope1.resolve("scopedService");
      const service2 = await scope2.resolve("scopedService");

      expect(service1).not.toBe(service2); // Different instances in different scopes

      await scope1.disposeScope();
      await scope2.disposeScope();
    });

    it("should delegate to parent for non-scoped services", async () => {
      const singletonValue = { value: "singleton" };
      container.registerSingleton("singleton", () => singletonValue);

      const scope = container.createScope();
      const resolved = await scope.resolve("singleton");

      expect(resolved).toBe(singletonValue);

      await scope.disposeScope();
    });
  });

  describe("Circular Dependency Detection", () => {
    it("should detect circular dependencies", async () => {
      container.register({
        name: "serviceA",
        factory: (c) => ({ b: c.resolve("serviceB") }),
        lifetime: ServiceLifetime.SINGLETON,
        dependencies: ["serviceB"],
      });

      container.register({
        name: "serviceB",
        factory: (c) => ({ a: c.resolve("serviceA") }),
        lifetime: ServiceLifetime.SINGLETON,
        dependencies: ["serviceA"],
      });

      await expect(container.resolve("serviceA")).rejects.toThrow(/Circular dependency detected/);
    });

    it("should allow disabling circular dependency detection", async () => {
      const configWithoutDetection: DIConfiguration = {
        enableCircularDependencyDetection: false,
      };

      const containerWithoutDetection = new DefaultServiceContainer(configWithoutDetection);

      containerWithoutDetection.register({
        name: "serviceA",
        factory: () => ({ value: "a" }), // Simplified to avoid actual circular call
        lifetime: ServiceLifetime.SINGLETON,
      });

      const result = await containerWithoutDetection.resolve<{ value: string }>("serviceA");
      expect(result.value).toBe("a");

      await containerWithoutDetection.dispose();
    });
  });

  describe("Container Statistics", () => {
    it("should track registration statistics", () => {
      container.registerSingleton("singleton1", () => ({}));
      container.registerSingleton("singleton2", () => ({}));
      container.registerScoped("scoped1", () => ({}));
      container.registerTransient("transient1", () => ({}));

      const stats = container.getStatistics();

      expect(stats.totalServices).toBe(4);
      expect(stats.singletonServices).toBe(2);
      expect(stats.scopedServices).toBe(1);
      expect(stats.transientServices).toBe(1);
    });

    it("should track resolution statistics", async () => {
      container.registerSingleton("test", () => ({ value: "test" }));

      await container.resolve("test");
      await container.resolve("test"); // Should hit cache

      const stats = container.getStatistics();

      expect(stats.totalResolutions).toBe(2);
      expect(stats.cacheHits).toBe(1); // Second resolution from cache
      expect(stats.averageResolutionTime).toBeGreaterThan(0);
    });
  });

  describe("Dependency Graph", () => {
    it("should build dependency graph", () => {
      container.registerSingleton("root", () => ({}));
      container.register({
        name: "middle",
        factory: (c) => ({ root: c.resolve("root") }),
        lifetime: ServiceLifetime.SINGLETON,
        dependencies: ["root"],
      });
      container.register({
        name: "leaf",
        factory: (c) => ({ middle: c.resolve("middle") }),
        lifetime: ServiceLifetime.SINGLETON,
        dependencies: ["middle"],
      });

      const graph = container.buildDependencyGraph();

      expect(graph.nodes.size).toBe(3);
      expect(graph.roots).toContain("root");
      expect(graph.leaves).toContain("leaf");

      const middleNode = graph.nodes.get("middle");
      expect(middleNode?.dependencies).toContain("root");
      expect(middleNode?.dependents).toContain("leaf");
    });
  });

  describe("Container Events", () => {
    it("should emit service registration events", (done) => {
      container.addEventListener(ContainerEvent.SERVICE_REGISTERED, (event, data) => {
        expect(event).toBe(ContainerEvent.SERVICE_REGISTERED);
        expect(data.serviceName).toBe("testService");
        expect(data.lifetime).toBe(ServiceLifetime.SINGLETON);
        done();
      });

      container.registerSingleton("testService", () => ({}));
    });

    it("should emit service resolution events", async () => {
      const resolutionEvents: Array<{
        event: ContainerEvent;
        data: { serviceName?: string; resolutionTime?: number };
      }> = [];

      container.addEventListener(ContainerEvent.SERVICE_RESOLVED, (event, data) => {
        resolutionEvents.push({ event, data });
      });

      container.registerSingleton("testService", () => ({ value: "test" }));
      await container.resolve("testService");

      expect(resolutionEvents).toHaveLength(1);
      expect(resolutionEvents[0].data.serviceName).toBe("testService");
      expect(resolutionEvents[0].data.resolutionTime).toBeGreaterThan(0);
    });
  });

  describe("Service Lifecycle", () => {
    it("should call initialize method on services", async () => {
      const initializeMock = jest.fn();

      class TestService {
        async initialize(): Promise<void> {
          initializeMock();
        }
      }

      container.registerSingleton("testService", () => new TestService());

      await container.resolve("testService");

      expect(initializeMock).toHaveBeenCalled();
    });

    it("should call dispose method on container disposal", async () => {
      const disposeMock = jest.fn();

      class TestService {
        async dispose(): Promise<void> {
          disposeMock();
        }
      }

      container.registerSingleton("testService", () => new TestService());
      await container.resolve("testService"); // Create instance

      await container.dispose();

      expect(disposeMock).toHaveBeenCalled();
    });

    it("should call custom dispose function", async () => {
      const customDisposeMock = jest.fn();

      container.register({
        name: "testService",
        factory: () => ({ value: "test" }),
        lifetime: ServiceLifetime.SINGLETON,
        dispose: customDisposeMock,
      });

      await container.resolve("testService"); // Create instance
      await container.dispose();

      expect(customDisposeMock).toHaveBeenCalled();
    });
  });

  describe("Container Hierarchy", () => {
    it("should create child container", () => {
      const child = container.createChild();

      expect(child).toBeInstanceOf(DefaultServiceContainer);
      expect(child.getParent()).toBe(container);
    });

    it("should resolve from parent when service not found in child", async () => {
      container.registerSingleton("parentService", () => ({ source: "parent" }));

      const child = container.createChild();
      const resolved = await child.resolve<{ source: string }>("parentService");

      expect(resolved.source).toBe("parent");

      await child.dispose();
    });

    it("should prefer child registration over parent", async () => {
      container.registerSingleton("sharedService", () => ({ source: "parent" }));

      const child = container.createChild();
      child.registerSingleton("sharedService", () => ({ source: "child" }));

      const resolved = await child.resolve<{ source: string }>("sharedService");

      expect(resolved.source).toBe("child");

      await child.dispose();
    });
  });

  describe("Error Handling", () => {
    it("should handle factory errors gracefully", async () => {
      container.registerSingleton("errorService", () => {
        throw new Error("Factory error");
      });

      await expect(container.resolve("errorService")).rejects.toThrow("Factory error");
    });

    it("should prevent registration on disposed container", async () => {
      await container.dispose();

      expect(() => {
        container.registerSingleton("test", () => ({}));
      }).toThrow("Cannot register services on disposed container");
    });

    it("should prevent resolution from disposed container", async () => {
      container.registerSingleton("test", () => ({}));
      await container.dispose();

      await expect(container.resolve("test")).rejects.toThrow(
        "Cannot resolve services from disposed container"
      );
    });
  });

  describe("Performance", () => {
    it("should cache singleton resolutions", async () => {
      let creationCount = 0;

      container.registerSingleton("cached", () => {
        creationCount++;
        return { id: creationCount };
      });

      const instance1 = await container.resolve<{ id: number }>("cached");
      const instance2 = await container.resolve<{ id: number }>("cached");
      const instance3 = await container.resolve<{ id: number }>("cached");

      expect(creationCount).toBe(1); // Factory called only once
      expect(instance1).toBe(instance2);
      expect(instance2).toBe(instance3);
    });

    it("should handle concurrent resolutions correctly", async () => {
      let creationCount = 0;

      container.registerSingleton("concurrent", async () => {
        creationCount++;
        await new Promise((resolve) => setTimeout(resolve, 10)); // Simulate async work
        return { id: creationCount };
      });

      // Resolve concurrently
      const promises = Array.from({ length: 5 }, () => container.resolve("concurrent"));
      const results = await Promise.all(promises);

      expect(creationCount).toBe(1); // Factory called only once despite concurrent access

      // All results should be the same instance
      const firstResult = results[0];
      results.forEach((result) => {
        expect(result).toBe(firstResult);
      });
    });
  });
});


// ===========================================================================
// Lumen Industries uplift — regression tests
// Container lifecycle, circular-dependency, scoped-service, and
// dependency-graph fixes. Each block fails on the pre-uplift container.
// ===========================================================================

describe("Uplift: circular dependencies via factory (undeclared deps)", () => {
  it("rejects with a clean error instead of deadlocking when the cycle exists only through factory resolve()", async () => {
    const container = new DefaultServiceContainer();
    // dependencies array intentionally omitted — the cycle exists only through
    // the factory's container.resolve() calls. Pre-uplift this produced a
    // never-resolving promise (the test would hang).
    container.registerSingleton("A", async (c) => ({ b: await c.resolve("B") }));
    container.registerSingleton("B", async (c) => ({ a: await c.resolve("A") }));

    await expect(container.resolve("A")).rejects.toThrow(/Circular dependency detected/);
    await container.dispose();
  });

  it("still resolves a diamond (shared, non-cyclic dependency) without a false positive", async () => {
    const container = new DefaultServiceContainer();
    let dCount = 0;
    container.registerSingleton("D", () => ({ id: ++dCount }));
    container.registerSingleton("B", async (c) => ({ d: await c.resolve("D") }));
    container.registerSingleton("C", async (c) => ({ d: await c.resolve("D") }));
    container.registerSingleton("A", async (c) => ({
      b: await c.resolve("B"),
      c: await c.resolve("C"),
    }));

    const a = await container.resolve<{
      b: { d: { id: number } };
      c: { d: { id: number } };
    }>("A");
    expect(a.b.d).toBe(a.c.d); // singleton D shared across both paths
    expect(dCount).toBe(1);
    await container.dispose();
  });

  it("emits a CIRCULAR_DEPENDENCY event for factory-only cycles", async () => {
    const container = new DefaultServiceContainer();
    const events: string[] = [];
    container.addEventListener(ContainerEvent.CIRCULAR_DEPENDENCY, (_e, data) => {
      events.push(String(data.serviceName));
    });
    container.registerSingleton("X", async (c) => ({ y: await c.resolve("Y") }));
    container.registerSingleton("Y", async (c) => ({ x: await c.resolve("X") }));

    await expect(container.resolve("X")).rejects.toThrow(/Circular dependency detected/);
    expect(events.length).toBeGreaterThan(0);
    await container.dispose();
  });
});

describe("Uplift: activeScopes counter no longer leaks", () => {
  it("returns to zero after all created scopes are disposed", async () => {
    const container = new DefaultServiceContainer();
    container.registerScoped("s", () => ({ id: Math.random() }));

    const scopes = Array.from({ length: 5 }, () => container.createScope());
    expect(container.getStatistics().activeScopes).toBe(5);

    for (const scope of scopes) {
      await scope.resolve("s");
    }
    for (const scope of scopes) {
      await scope.disposeScope();
    }

    expect(container.getStatistics().activeScopes).toBe(0);
    await container.dispose();
  });

  it("does not underflow below zero on double dispose", async () => {
    const container = new DefaultServiceContainer();
    const scope = container.createScope();
    await scope.disposeScope();
    await scope.disposeScope(); // idempotent
    expect(container.getStatistics().activeScopes).toBe(0);
    await container.dispose();
  });
});

describe("Uplift: scoped services get the full lifecycle", () => {
  it("invokes initialize() on scoped services exactly once per scope", async () => {
    const container = new DefaultServiceContainer();
    const init = jest.fn();
    class ScopedThing {
      async initialize(): Promise<void> {
        init();
      }
    }
    container.registerScoped("thing", () => new ScopedThing());

    const scope = container.createScope();
    const a = await scope.resolve("thing");
    const b = await scope.resolve("thing");
    expect(a).toBe(b); // cached within the scope
    expect(init).toHaveBeenCalledTimes(1); // and initialized exactly once
    await scope.disposeScope();
    await container.dispose();
  });

  it("resolves Promise-valued fields returned by a scoped factory", async () => {
    const container = new DefaultServiceContainer();
    container.registerSingleton("dep", () => ({ value: 42 }));
    container.registerScoped("scopedWithDep", (c) => ({
      dep: c.resolve("dep"), // a Promise stored as a field
      tag: "scoped",
    }));

    const scope = container.createScope();
    const svc = await scope.resolve<{ dep: { value: number }; tag: string }>("scopedWithDep");
    expect(svc.tag).toBe("scoped");
    expect(svc.dep).not.toHaveProperty("then"); // resolved value, not a pending Promise
    expect(svc.dep.value).toBe(42);
    await scope.disposeScope();
    await container.dispose();
  });

  it("detects circular dependencies between two scoped services", async () => {
    const container = new DefaultServiceContainer();
    container.registerScoped("P", async (c) => ({ q: await c.resolve("Q") }));
    container.registerScoped("Q", async (c) => ({ p: await c.resolve("P") }));
    const scope = container.createScope();
    await expect(scope.resolve("P")).rejects.toThrow(/Circular dependency detected/);
    await scope.disposeScope();
    await container.dispose();
  });
});

describe("Uplift: dependency-graph cycle detection is accurate", () => {
  const reg = (container: DefaultServiceContainer, name: string, dep?: string): void => {
    container.register({
      name,
      factory: () => ({}),
      lifetime: ServiceLifetime.SINGLETON,
      dependencies: dep ? [dep] : undefined,
    });
  };

  it("reports a 2-node cycle exactly once with no spurious prefix", () => {
    const container = new DefaultServiceContainer();
    reg(container, "A", "B");
    reg(container, "B", "A");
    const graph = container.buildDependencyGraph();
    expect(graph.cycles).toHaveLength(1);
    expect(new Set(graph.cycles[0])).toEqual(new Set(["A", "B"]));
  });

  it("reports a 3-node cycle once", () => {
    const container = new DefaultServiceContainer();
    reg(container, "A", "B");
    reg(container, "B", "C");
    reg(container, "C", "A");
    const graph = container.buildDependencyGraph();
    expect(graph.cycles).toHaveLength(1);
    expect(new Set(graph.cycles[0])).toEqual(new Set(["A", "B", "C"]));
  });

  it("reports no cycles for an acyclic graph", () => {
    const container = new DefaultServiceContainer();
    reg(container, "root");
    reg(container, "mid", "root");
    reg(container, "leaf", "mid");
    const graph = container.buildDependencyGraph();
    expect(graph.cycles).toHaveLength(0);
  });

  it("reports two independent cycles separately", () => {
    const container = new DefaultServiceContainer();
    reg(container, "A", "B");
    reg(container, "B", "A");
    reg(container, "C", "D");
    reg(container, "D", "C");
    const graph = container.buildDependencyGraph();
    expect(graph.cycles).toHaveLength(2);
  });
});

describe("Uplift: resolveAll tag index preserves behavior", () => {
  it("returns all services for a tag and [] for an unknown tag", async () => {
    const container = new DefaultServiceContainer();
    container.register({
      name: "h1",
      factory: () => ({ t: "email" }),
      lifetime: ServiceLifetime.TRANSIENT,
      tags: ["handler", "io"],
    });
    container.register({
      name: "h2",
      factory: () => ({ t: "sms" }),
      lifetime: ServiceLifetime.TRANSIENT,
      tags: ["handler"],
    });

    const handlers = await container.resolveAll<{ t: string }>("handler");
    expect(handlers.map((h) => h.t).sort()).toEqual(["email", "sms"]);

    const io = await container.resolveAll<{ t: string }>("io");
    expect(io).toHaveLength(1);

    const none = await container.resolveAll("does-not-exist");
    expect(none).toEqual([]);
    await container.dispose();
  });
});

describe("Uplift: scopeTimeout configuration is honored", () => {
  const savedWorker = process.env.JEST_WORKER_ID;
  const savedNodeEnv = process.env.NODE_ENV;

  afterEach(() => {
    jest.useRealTimers();
    if (savedWorker === undefined) delete process.env.JEST_WORKER_ID;
    else process.env.JEST_WORKER_ID = savedWorker;
    if (savedNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = savedNodeEnv;
  });

  it("auto-disposes an idle scope after the configured scopeTimeout", async () => {
    // Force the non-test branch so the timer actually arms; fake the clock.
    delete process.env.JEST_WORKER_ID;
    process.env.NODE_ENV = "development";
    jest.useFakeTimers();

    const container = new DefaultServiceContainer({ scopeTimeout: 50 });
    container.registerScoped("s", () => ({ id: 1 }));
    const scope = container.createScope();
    await scope.resolve("s");

    await jest.advanceTimersByTimeAsync(60);

    await expect(scope.resolve("s")).rejects.toThrow(/disposed scope/);
    expect(container.getStatistics().activeScopes).toBe(0);

    jest.useRealTimers();
    await container.dispose();
  });
});
