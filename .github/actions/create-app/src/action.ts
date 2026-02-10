import * as core from "@actions/core";
import * as exec from "@actions/exec";
import * as yaml from "js-yaml";

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
}

// ── Helpers ─────────────────────────────────────────────────

async function api(
  method: string,
  path: string,
  apiKey: string,
  body?: object,
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
  // ghcr.io/bunnyway/mc-go-test -> namespace="bunnyway", name="mc-go-test"
  // redis -> namespace="library", name="redis"
  // ghcr.io/org/repo/api -> namespace="org/repo", name="api"
  const parts = fullImage.split("/");
  if (parts.length === 1) {
    return { imageNamespace: "library", imageName: parts[0] };
  }
  // Remove registry host (first part if it contains a dot or colon)
  const hasRegistryHost = parts[0].includes(".") || parts[0].includes(":");
  const pathParts = hasRegistryHost ? parts.slice(1) : parts;
  const imageName = pathParts.pop() || "";
  const imageNamespace = pathParts.join("/") || "library";
  return { imageNamespace, imageName };
}

function parseContainers(
  raw: string,
  defaults: { registry: string; sha: string },
): ContainerDef[] {
  const parsed = yaml.load(raw);
  if (!Array.isArray(parsed)) {
    throw new Error(
      "containers input must be a YAML list. Got: " + typeof parsed,
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
    };
  });
}

// ── Main ────────────────────────────────────────────────────

export async function run() {
  try {
    const apiKey = core.getInput("api_key", { required: true });
    const appName = core.getInput("app_name", { required: true });
    const deploymentType = core.getInput("deployment_type");
    const region = core.getInput("region");
    const registry = core.getInput("registry");
    const registryUsername = core.getInput("registry_username");
    const registryPassword = core.getInput("registry_password");
    const createEndpoint = core.getInput("create_endpoint") === "true";
    const endpointType = core.getInput("endpoint_type");
    const endpointName =
      core.getInput("endpoint_name") || `${appName}-endpoint`;
    const endpointContainer = core.getInput("endpoint_container");
    const ensureBunnyRegistry =
      core.getInput("ensure_bunny_registry") === "true";
    const bunnyRegistryName = core.getInput("bunny_registry_name");
    const bunnyRegistryPat = core.getInput("bunny_registry_pat");
    const bunnyRegistryType = core.getInput("bunny_registry_type");
    const waitForDeploy = core.getInput("wait_for_deployment") === "true";
    const timeout = parseInt(core.getInput("deployment_timeout"), 10);

    const sha = process.env.GITHUB_SHA || "latest";

    // Parse container definitions
    const containersRaw = core.getInput("containers", { required: true });
    const containers = parseContainers(containersRaw, { registry, sha });

    const buildContainers = containers.filter((c) => c.build);

    core.info(
      `Parsed ${containers.length} container(s): ` +
        `${buildContainers.length} to build, ` +
        `${containers.length - buildContainers.length} pre-built`,
    );

    // ── Step 1: Build & Push images ───────────────────────
    if (buildContainers.length > 0) {
      core.startGroup("Build and push images");

      if (registryPassword) {
        await exec.exec(
          "docker",
          ["login", registry, "-u", registryUsername, "--password-stdin"],
          { input: Buffer.from(registryPassword) },
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
        `  - ${r.displayName} (id: ${r.id}, host: ${r.hostName || "n/a"}, public: ${r.isPublic || false})`,
      );
    }

    // Find or create a Docker Hub registry for public images
    const hasPublicImages = containers.some((c) => !c.build);
    let dockerHubRegistryId: string | undefined;

    if (hasPublicImages) {
      const dockerHubRegistry = registryItems.find(
        (r) =>
          r.hostName === "docker.io" ||
          r.displayName?.toLowerCase().includes("docker"),
      );

      if (dockerHubRegistry) {
        dockerHubRegistryId = String(dockerHubRegistry.id);
        core.info(
          `Using Docker Hub registry: ${dockerHubRegistry.displayName} (id: ${dockerHubRegistryId})`,
        );
      } else {
        core.info(
          "No Docker Hub registry found. Creating one for public images...",
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
        core.info(`Created Docker Hub registry (id: ${dockerHubRegistryId})`);
      }
    }

    // Find or create a private registry for built images (GHCR, etc.)
    let privateRegistryId: string | undefined;

    if (
      buildContainers.length > 0 &&
      (bunnyRegistryName || ensureBunnyRegistry)
    ) {
      const searchName = (bunnyRegistryName || registryUsername).toLowerCase();

      const existing = registryItems.find(
        (r) => r.displayName?.toLowerCase() === searchName,
      );

      if (existing) {
        core.info(
          `Found private registry: ${existing.displayName} (id: ${existing.id})`,
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

    // Map deployment_type input to API fields
    const runtimeType = deploymentType === "advanced" ? "Reserved" : "Shared";

    const regionSettings: Record<string, unknown> = {};
    if (deploymentType === "single" && region) {
      regionSettings.requiredRegionIds = [region];
      regionSettings.allowedRegionIds = [region];
      regionSettings.maxAllowedRegions = 1;
    } else {
      regionSettings.requiredRegionIds = [];
      regionSettings.allowedRegionIds = [];
    }

    // Build container templates inline with the app
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
          ([name, value]) => ({ name, value: String(value) }),
        );
      }

      if (c.port && createEndpoint) {
        const exposeContainerName =
          endpointContainer ||
          containers.find((ct) => ct.port)?.name ||
          containers[0].name;

        if (c.name === exposeContainerName) {
          const endpointPayload: Record<string, unknown> = {
            displayName: endpointName,
          };

          if (endpointType === "CDN") {
            endpointPayload.cdn = {
              portMappings: [{ containerPort: c.port }],
            };
          } else if (endpointType === "Anycast") {
            endpointPayload.anycast = {
              type: "IPv4",
              portMappings: [{ containerPort: c.port }],
            };
          }

          template.endpoints = [endpointPayload];
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
          `App did not become active within ${timeout}s (last: ${status})`,
        );
      }
    }
    core.endGroup();

    // ── Step 5: Retrieve endpoint URL ─────────────────────
    if (createEndpoint) {
      core.startGroup("Retrieve deployed URL");

      const appDetails = await api("GET", `/apps/${appId}`, apiKey);

      // Check displayEndpoint first (top-level convenience field)
      let hostname = appDetails?.displayEndpoint?.address || "";

      // Fall back to digging through container templates
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
          "No endpoint URL found yet (may take a moment to provision).",
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
          (c.build ? " [built]" : " [pre-built]"),
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
