import * as core from "@actions/core";
import * as exec from "@actions/exec";
import * as fs from "fs";
import * as yaml from "js-yaml";
import * as TOML from "smol-toml";

const API_BASE = "https://api.bunny.net/mc";

// ── Types ───────────────────────────────────────────────────

interface ContainerDef {
  name: string;
  image: string;
  tag: string;
  port?: number;
  build: boolean;
  context: string;
  dockerfile: string;
  env: Record<string, string>;
  endpoints: EndpointDef[];
}

interface EndpointDef {
  name: string;
  type: string; // "cdn" | "anycast"
  ports: { container: number; exposed?: number; protocols?: string[] }[];
}

interface AppConfig {
  name: string;
  containers: ContainerDef[];
}

// ── Helpers ─────────────────────────────────────────────────

async function api(
  method: string,
  path: string,
  apiKey: string,
  body?: object
) {
  const url = `${API_BASE}${path}`;
  const opts: RequestInit = {
    method,
    headers: {
      AccessKey: apiKey,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
  };
  if (body) opts.body = JSON.stringify(body);

  core.debug(`${method} ${url}`);
  if (body) core.debug(JSON.stringify(body, null, 2));

  const res = await fetch(url, opts);
  const text = await res.text();

  if (!res.ok) {
    throw new Error(`API ${method} ${path} failed (${res.status}): ${text}`);
  }
  return text ? JSON.parse(text) : null;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function parseImageParts(fullImage: string): {
  imageNamespace: string;
  imageName: string;
} {
  const parts = fullImage.split("/");
  if (parts.length === 1) {
    return { imageNamespace: "library", imageName: parts[0] };
  }
  const hasRegistryHost = parts[0].includes(".") || parts[0].includes(":");
  const pathParts = hasRegistryHost ? parts.slice(1) : parts;
  const imageName = pathParts.pop() || "";
  const imageNamespace = pathParts.join("/") || "library";
  return { imageNamespace, imageName };
}

// ── Config Parsing ──────────────────────────────────────────

function parseFromToml(
  tomlPath: string,
  defaults: { registry: string; sha: string }
): AppConfig {
  const raw = fs.readFileSync(tomlPath, "utf-8");
  const parsed = TOML.parse(raw);

  const name = (parsed.name as string) || "";
  const rawContainers = (parsed.containers as Record<string, unknown>[]) || [];

  const containers: ContainerDef[] = rawContainers.map((c, i) => {
    const cName = (c.name as string) || "";
    if (!cName) throw new Error(`Container at index ${i} in bunny.toml missing 'name'`);

    const isBuild = c.build === true;
    let image = (c.image as string) || "";

    // If no image specified and build is true, infer from registry + app name
    if (!image && isBuild) {
      image = `${defaults.registry}/${name}`;
    }
    if (!image) {
      throw new Error(`Container '${cName}' in bunny.toml missing 'image'`);
    }

    if (isBuild && !image.includes("/")) {
      image = `${defaults.registry}/${image}`;
    }

    const env: Record<string, string> = {};
    if (c.env && typeof c.env === "object") {
      for (const [k, v] of Object.entries(c.env as Record<string, unknown>)) {
        env[k] = String(v);
      }
    }

    // Parse endpoints from TOML
    const rawEndpoints = (c.endpoints as Record<string, unknown>[]) || [];
    const endpoints: EndpointDef[] = rawEndpoints.map((ep) => {
      const rawPorts = (ep.ports as Record<string, unknown>[]) || [];
      return {
        name: (ep.name as string) || `${cName}-endpoint`,
        type: ((ep.type as string) || "cdn").toLowerCase(),
        ports: rawPorts.map((p) => ({
          container: (p.container as number) || 80,
          exposed: p.exposed as number | undefined,
          protocols: p.protocols as string[] | undefined,
        })),
      };
    });

    // Infer port from first endpoint port mapping
    let port: number | undefined;
    if (c.port) {
      port = Number(c.port);
    } else if (endpoints.length > 0 && endpoints[0].ports.length > 0) {
      port = endpoints[0].ports[0].container;
    }

    return {
      name: cName,
      image,
      tag: (c.tag as string) || (isBuild ? defaults.sha : "latest"),
      port,
      build: isBuild,
      context: (c.context as string) || ".",
      dockerfile: (c.dockerfile as string) || "Dockerfile",
      env,
      endpoints,
    };
  });

  return { name, containers };
}

function parseFromYaml(
  raw: string,
  defaults: { registry: string; sha: string }
): ContainerDef[] {
  const parsed = yaml.load(raw);
  if (!Array.isArray(parsed)) {
    throw new Error(
      "containers input must be a YAML list. Got: " + typeof parsed
    );
  }

  return parsed.map((c, i: number) => {
    if (!c.name) throw new Error(`Container at index ${i} missing 'name'`);
    if (!c.image) throw new Error(`Container '${c.name}' missing 'image'`);

    const isBuild = c.build === true;

    let image = c.image;
    if (isBuild && !image.includes("/")) {
      image = `${defaults.registry}/${image}`;
    }

    return {
      name: c.name,
      image,
      tag: c.tag || (isBuild ? defaults.sha : "latest"),
      port: c.port ? Number(c.port) : undefined,
      build: isBuild,
      context: c.context || ".",
      dockerfile: c.dockerfile || "Dockerfile",
      env: c.env || {},
      endpoints: [],
    };
  });
}

// ── Main ────────────────────────────────────────────────────

export async function run() {
  try {
    const apiKey = core.getInput("api_key", { required: true });
    const configPath = core.getInput("config");
    const deploymentType = core.getInput("deployment_type");
    const region = core.getInput("region");
    const registry = core.getInput("registry");
    const registryUsername = core.getInput("registry_username");
    const registryPassword = core.getInput("registry_password");
    const endpointType = core.getInput("endpoint_type");
    const endpointName = core.getInput("endpoint_name");
    const endpointContainer = core.getInput("endpoint_container");
    const createEndpointInput = core.getInput("create_endpoint");
    const ensureBunnyRegistry =
      core.getInput("ensure_bunny_registry") === "true";
    const bunnyRegistryName = core.getInput("bunny_registry_name");
    const bunnyRegistryPat = core.getInput("bunny_registry_pat");
    const bunnyRegistryType = core.getInput("bunny_registry_type");
    const waitForDeploy = core.getInput("wait_for_deployment") === "true";
    const timeout = parseInt(core.getInput("deployment_timeout"), 10);

    const sha = process.env.GITHUB_SHA || "latest";
    const parseDefaults = { registry, sha };

    // ── Load config ─────────────────────────────────────────
    let appName = core.getInput("app_name");
    let containers: ContainerDef[];

    const containersInput = core.getInput("containers");
    const hasToml = configPath && fs.existsSync(configPath);

    if (hasToml) {
      core.info(`Reading config from ${configPath}`);
      const config = parseFromToml(configPath, parseDefaults);
      if (!appName) appName = config.name;
      containers = config.containers;
    } else if (containersInput) {
      core.info("Reading containers from workflow input");
      containers = parseFromYaml(containersInput, parseDefaults);
    } else {
      throw new Error(
        "No bunny.toml found and no 'containers' input provided. " +
          "Either add a bunny.toml to your repo or pass the containers input."
      );
    }

    if (!appName) {
      throw new Error(
        "App name is required. Set 'app_name' input or 'name' in bunny.toml."
      );
    }

    // Determine if endpoints should be created
    // From bunny.toml: any container has endpoints defined
    // From workflow input: create_endpoint defaults to "true"
    const hasTomlEndpoints = containers.some((c) => c.endpoints.length > 0);
    const createEndpoint = hasToml
      ? hasTomlEndpoints
      : createEndpointInput === "true";

    const buildContainers = containers.filter((c) => c.build);

    core.info(
      `App: ${appName} | ${containers.length} container(s): ` +
        `${buildContainers.length} to build, ` +
        `${containers.length - buildContainers.length} pre-built`
    );

    // ── Step 1: Build & Push images ───────────────────────
    if (buildContainers.length > 0) {
      core.startGroup("Build and push images");

      if (registryPassword) {
        await exec.exec(
          "docker",
          ["login", registry, "-u", registryUsername, "--password-stdin"],
          { input: Buffer.from(registryPassword) }
        );
      }

      for (const c of buildContainers) {
        const fullRef = `${c.image}:${c.tag}`;
        core.info(`Building ${c.name} -> ${fullRef}`);

        await exec.exec("docker", [
          "build",
          "-t",
          fullRef,
          "-f",
          c.dockerfile,
          "--platform",
          "linux/amd64",
          c.context,
        ]);

        core.info(`Pushing ${fullRef}`);
        await exec.exec("docker", ["push", fullRef]);
      }

      core.endGroup();
    }

    // ── Step 2: Ensure Bunny Image Registries ──────────────
    core.startGroup("Ensure Bunny image registries");

    const registriesResponse = await api("GET", "/registries", apiKey);
    const registryItems = registriesResponse?.items || [];

    core.info(`Found ${registryItems.length} existing registry(ies)`);
    for (const r of registryItems) {
      core.info(
        `  - ${r.displayName} (id: ${r.id}, host: ${r.hostName || "n/a"}, public: ${r.isPublic || false})`
      );
    }

    // Find or create a Docker Hub registry for public images
    const hasPublicImages = containers.some((c) => !c.build);
    let dockerHubRegistryId: string | undefined;

    if (hasPublicImages) {
      const dockerHubRegistry = registryItems.find(
        (r) =>
          r.hostName === "docker.io" ||
          r.displayName?.toLowerCase().includes("docker")
      );

      if (dockerHubRegistry) {
        dockerHubRegistryId = String(dockerHubRegistry.id);
        core.info(
          `Using Docker Hub registry: ${dockerHubRegistry.displayName} (id: ${dockerHubRegistryId})`
        );
      } else {
        core.info(
          "No Docker Hub registry found. Creating one for public images..."
        );
        const created = await api("POST", "/registries", apiKey, {
          displayName: "Docker Hub",
          type: "DockerHub",
          passwordCredentials: {
            userName: "public",
            password: "public",
          },
        });
        dockerHubRegistryId = String(created.id);
        core.info(
          `Created Docker Hub registry (id: ${dockerHubRegistryId})`
        );
      }
    }

    // Find or create a private registry for built images
    let privateRegistryId: string | undefined;

    if (
      buildContainers.length > 0 &&
      (bunnyRegistryName || ensureBunnyRegistry)
    ) {
      const searchName = (
        bunnyRegistryName || registryUsername
      ).toLowerCase();

      const existing = registryItems.find(
        (r) => r.displayName?.toLowerCase() === searchName
      );

      if (existing) {
        core.info(
          `Found private registry: ${existing.displayName} (id: ${existing.id})`
        );
        privateRegistryId = String(existing.id);
      } else if (ensureBunnyRegistry) {
        core.info("Creating private image registry...");
        const created = await api("POST", "/registries", apiKey, {
          displayName: bunnyRegistryName || registryUsername,
          type: bunnyRegistryType,
          passwordCredentials: {
            userName: registryUsername,
            password: bunnyRegistryPat || registryPassword,
          },
        });
        privateRegistryId = String(created.id);
        core.info(`Created private registry (id: ${privateRegistryId})`);
      }
    }

    core.endGroup();

    // ── Step 3: Create the App ────────────────────────────
    core.startGroup("Create Magic Containers application");

    const runtimeType =
      deploymentType === "advanced" ? "Reserved" : "Shared";

    const regionSettings: Record<string, unknown> = {};
    if (deploymentType === "single" && region) {
      regionSettings.requiredRegionIds = [region];
      regionSettings.allowedRegionIds = [region];
      regionSettings.maxAllowedRegions = 1;
    } else {
      regionSettings.requiredRegionIds = [];
      regionSettings.allowedRegionIds = [];
    }

    // Build container templates
    const containerTemplates = containers.map((c) => {
      const { imageNamespace, imageName } = parseImageParts(c.image);

      const template: Record<string, unknown> = {
        name: c.name,
        image: `${c.image}:${c.tag}`,
        imageName,
        imageNamespace,
        imageTag: c.tag,
        imageRegistryId:
          c.build && privateRegistryId
            ? privateRegistryId
            : dockerHubRegistryId || "",
        imagePullPolicy: "Always",
      };

      if (c.env && Object.keys(c.env).length > 0) {
        template.environmentVariables = Object.entries(c.env).map(
          ([name, value]) => ({ name, value: String(value) })
        );
      }

      // Build endpoints from bunny.toml definitions
      if (c.endpoints.length > 0) {
        template.endpoints = c.endpoints.map((ep) => {
          const epPayload: Record<string, unknown> = {
            displayName: ep.name,
          };

          const portMappings = ep.ports.map((p) => ({
            containerPort: p.container,
            ...(p.exposed ? { exposedPort: p.exposed } : {}),
          }));

          if (ep.type === "cdn") {
            epPayload.cdn = { portMappings };
          } else if (ep.type === "anycast") {
            epPayload.anycast = { type: "IPv4", portMappings };
          }

          return epPayload;
        });
      } else if (createEndpoint && c.port) {
        // Fallback: workflow-input style endpoint
        const exposeContainerName =
          endpointContainer ||
          containers.find((ct) => ct.port)?.name ||
          containers[0].name;

        if (c.name === exposeContainerName) {
          const resolvedName =
            endpointName || `${appName}-endpoint`;
          const resolvedType = (endpointType || "CDN").toUpperCase();
          const epPayload: Record<string, unknown> = {
            displayName: resolvedName,
          };

          if (resolvedType === "CDN") {
            epPayload.cdn = {
              portMappings: [{ containerPort: c.port }],
            };
          } else if (resolvedType === "ANYCAST") {
            epPayload.anycast = {
              type: "IPv4",
              portMappings: [{ containerPort: c.port }],
            };
          }

          template.endpoints = [epPayload];
        }
      }

      return template;
    });

    const appPayload = {
      name: appName,
      runtimeType,
      autoScaling: { min: 1, max: 3 },
      regionSettings,
      containerTemplates,
    };

    const app = await api("POST", "/apps", apiKey, appPayload);
    const appId = app.id;
    core.info(`App created: ${appName} (id: ${appId})`);
    core.setOutput("app_id", appId);

    core.endGroup();

    // ── Step 4: Deploy ────────────────────────────────────
    core.startGroup("Deploy application");
    await api("POST", `/apps/${appId}/deploy`, apiKey);
    core.info("Deploy triggered.");

    if (waitForDeploy) {
      const deadline = Date.now() + timeout * 1000;
      let status = "";
      while (Date.now() < deadline) {
        const appStatus = await api("GET", `/apps/${appId}`, apiKey);
        status = appStatus?.status || "";
        core.info(`  Status: ${status}`);
        if (status === "Active") break;
        await sleep(10_000);
      }
      if (status !== "Active") {
        core.warning(
          `App did not become active within ${timeout}s (last: ${status})`
        );
      }
    }
    core.endGroup();

    // ── Step 5: Retrieve endpoint URL ─────────────────────
    if (createEndpoint) {
      core.startGroup("Retrieve deployed URL");

      const appDetails = await api("GET", `/apps/${appId}`, apiKey);

      let hostname = appDetails?.displayEndpoint?.address || "";

      if (!hostname) {
        const appContainers = appDetails?.containerTemplates || [];
        for (const ct of appContainers) {
          const endpoints = ct.endpoints || [];
          if (endpoints.length > 0) {
            hostname = endpoints[0].publicHost || "";
            break;
          }
        }
      }

      const appUrl = hostname
        ? hostname.startsWith("http")
          ? hostname
          : `https://${hostname}`
        : "";

      if (appUrl) {
        core.info(`Deployed URL: ${appUrl}`);
      } else {
        core.info(
          "No endpoint URL found yet (may take a moment to provision)."
        );
      }
      core.setOutput("app_url", appUrl);
      core.setOutput("endpoint_hostname", hostname);
      core.endGroup();
    }

    core.info("App is live on Magic Containers!");
    core.info(`  App:  ${appName} (${appId})`);
    for (const c of containers) {
      core.info(
        `  Container: ${c.name} -> ${c.image}:${c.tag}` +
          (c.port ? ` (port ${c.port})` : "") +
          (c.build ? " [built]" : " [pre-built]")
      );
    }
  } catch (e) {
    if (typeof e === "string" || e instanceof Error) {
      core.setFailed(e);
    } else {
      core.setFailed("Unexpected error");
    }
  }
}
