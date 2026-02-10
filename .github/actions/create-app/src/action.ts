import * as core from "@actions/core";
import * as exec from "@actions/exec";
import * as yaml from "js-yaml";

const API_BASE = "https://api.bunny.net/mc";

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

    // Step 1: Build & Push images that need building
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

    // Step 2: Ensure Bunny Image Registry
    let registryId: number | undefined;

    if (bunnyRegistryName || ensureBunnyRegistry) {
      core.startGroup("Ensure Bunny image registry");

      const registries = await api("GET", "/registries", apiKey);
      const searchName = (bunnyRegistryName || registryUsername).toLowerCase();

      const existing = (Array.isArray(registries) ? registries : []).find(
        (r) => r.name?.toLowerCase() === searchName,
      );

      if (existing) {
        core.info(
          `Found existing registry: ${existing.name} (id: ${existing.id})`,
        );
        registryId = existing.id;
      } else if (ensureBunnyRegistry) {
        core.info("Creating Bunny image registry...");
        const created = await api("POST", "/registries", apiKey, {
          name: bunnyRegistryName || registryUsername,
          registryType: bunnyRegistryType,
          username: registryUsername,
          personalAccessToken: bunnyRegistryPat || registryPassword,
        });
        registryId = created.id;
        core.info(`Created registry (id: ${registryId})`);
      }

      core.endGroup();
    }

    // Step 3: Create the App
    core.startGroup("Create Magic Containers application");

    const appPayload: Record<string, unknown> = {
      name: appName,
      deploymentType,
    };

    if (deploymentType === "single" && region) {
      appPayload.region = region;
    }

    const app = await api("POST", "/apps", apiKey, appPayload);
    const appId = app.id;
    core.info(`App created: ${appName} (id: ${appId})`);
    core.setOutput("app_id", appId);

    core.endGroup();

    // Step 4: Add each container
    core.startGroup(`Add ${containers.length} container(s) to the app`);

    const containerIdMap: Record<string, string> = {};

    for (const c of containers) {
      core.info(`Adding container: ${c.name} (${c.image}:${c.tag})`);

      const containerPayload: Record<string, unknown> = {
        name: c.name,
        image: c.image,
        imageTag: c.tag,
      };

      if (registryId && c.build) {
        containerPayload.containerRegistryId = registryId;
      }

      if (c.env && Object.keys(c.env).length > 0) {
        containerPayload.environmentVariables = c.env;
      }

      const created = await api(
        "POST",
        `/apps/${appId}/containers`,
        apiKey,
        containerPayload,
      );
      containerIdMap[c.name] = created.id;
      core.info(`  ${c.name} added (id: ${created.id})`);
    }

    core.endGroup();

    // Step 5: Create endpoint
    if (createEndpoint) {
      core.startGroup("Create endpoint");

      const exposeContainerName =
        endpointContainer ||
        containers.find((c) => c.port)?.name ||
        containers[0].name;

      const exposeContainerId = containerIdMap[exposeContainerName];
      if (!exposeContainerId) {
        throw new Error(
          `Could not find container "${exposeContainerName}" for endpoint`,
        );
      }

      const exposePort =
        containers.find((c) => c.name === exposeContainerName)?.port || 80;

      await api(
        "POST",
        `/apps/${appId}/containers/${exposeContainerId}/endpoints`,
        apiKey,
        {
          name: endpointName,
          type: endpointType,
          port: exposePort,
        },
      );

      core.info(
        `Endpoint '${endpointName}' created (${endpointType}, ` +
          `exposing: ${exposeContainerName}:${exposePort})`,
      );
      core.endGroup();
    }

    // Step 6: Deploy
    core.startGroup("Deploy application");
    await api("POST", `/apps/${appId}/deploy`, apiKey);
    core.info("Deploy triggered.");

    if (waitForDeploy) {
      const deadline = Date.now() + timeout * 1000;
      let status = "";
      while (Date.now() < deadline) {
        const appStatus = await api("GET", `/apps/${appId}`, apiKey);
        status = appStatus?.status || appStatus?.state || "";
        core.info(`  Status: ${status}`);
        if (/^(active|running)$/i.test(status)) break;
        await sleep(10_000);
      }
      if (!/^(active|running)$/i.test(status)) {
        core.warning(
          `App did not become active within ${timeout}s (last: ${status})`,
        );
      }
    }
    core.endGroup();

    // Step 7: Retrieve endpoint URL
    if (createEndpoint) {
      core.startGroup("Retrieve deployed URL");

      const appDetails = await api("GET", `/apps/${appId}`, apiKey);

      let hostname = "";
      const appContainers =
        appDetails?.containers || appDetails?.containerTemplates || [];
      for (const ct of appContainers) {
        const endpoints = ct.endpoints || [];
        if (endpoints.length > 0) {
          hostname = endpoints[0].hostname || endpoints[0].url || "";
          break;
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
