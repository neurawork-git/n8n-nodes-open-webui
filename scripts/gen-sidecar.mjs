/**
 * Erzeugt `n8nac-custom-nodes.json` aus dem gebauten `dist`.
 *
 * n8nac kennt eigene Nodes nur über diese Sidecar-Datei im Arbeitsverzeichnis
 * des Workflow-Repos. Fehlt sie oder ist sie veraltet, meldet `skills validate`
 * neue Parameter als „Unknown parameter“ und `node-info` liefert leer statt
 * Fehler. Übernommen aus `n8n-nodes-neurawork/scripts/gen-sidecar.ts`.
 *
 *     npm run build
 *     npm run gen:sidecar -- ../<workflow-repo>/n8n
 *
 * Typpräfix: Als Community-Paket über Einstellungen → Community Nodes
 * installiert, registriert n8n die Nodes unter `<paketname>.<name>`
 * (`n8n-nodes-open-webui.openWebUi`). Der CI-Job `n8n-load` belegt den Namen.
 *
 * Bewusst JavaScript statt TypeScript: Dateien unter `scripts/` fallen sonst
 * unter den n8n-Community-Lint, der `process` und `fs` verbietet.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const targetDir = resolve(process.argv[2] ?? repoRoot);
const pkg = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8'));

const distNodes = (pkg.n8n?.nodes ?? []).map((entry) => resolve(repoRoot, entry));
if (distNodes.length === 0) throw new Error('package.json → n8n.nodes ist leer.');

const nodes = {};
for (const file of distNodes) {
	if (!existsSync(file)) {
		throw new Error(`${file} fehlt. Erst "npm run build", dann "npm run gen:sidecar".`);
	}
	const module = require(file);
	for (const Exported of Object.values(module)) {
		if (typeof Exported !== 'function') continue;
		// Ein Node-Modul exportiert auch Hilfsfunktionen. Die tragen keine
		// `description` und werfen beim Instanziieren — das ist das Erkennungsmerkmal.
		let description;
		try {
			description = new Exported().description;
		} catch {
			continue;
		}
		if (!description?.name || !Array.isArray(description.properties)) continue;

		const credentials = description.credentials ?? [];
		nodes[description.name] = {
			name: description.name,
			type: `${pkg.name}.${description.name}`,
			displayName: description.displayName,
			description: description.description,
			version: description.version,
			group: description.group ?? ['transform'],
			icon: description.icon,
			usableAsTool: Boolean(description.usableAsTool),
			credentials,
			schema: { credentials, properties: description.properties },
			metadata: { packageName: pkg.name, packageVersion: pkg.version, source: repoRoot },
		};
	}
}

const out = join(targetDir, 'n8nac-custom-nodes.json');
writeFileSync(
	out,
	`${JSON.stringify({ generatedAt: new Date().toISOString(), sourceData: `${pkg.name}@${pkg.version}`, nodes }, null, 2)}\n`,
	'utf8',
);
process.stdout.write(
	`${out}\n  ${Object.keys(nodes).length} Nodes aus ${pkg.name}@${pkg.version}: ${Object.keys(nodes).join(', ')}\n`,
);
