/**
 * Popup UI wiring only — the extension is a UI placeholder today (see
 * docs/architecture.md, "Current state of apps/extension").
 *
 * This intentionally does not detect archive format or parse anything:
 * apps/extension has no bundler, so it cannot import @xarsh/archivebridge
 * without either adding one or duplicating parsing logic here. Duplicating
 * it would break CONTRIBUTING.md's boundary rule that the extension must
 * not reimplement archive parsing, so this stays a plain file picker until
 * the bundler question is decided — which is what capture/save adapters
 * will force.
 */

function requireElement<T extends Element>(id: string, ctor: new () => T): T {
	const element = document.getElementById(id)
	if (!(element instanceof ctor)) {
		throw new Error(`popup.html is missing element #${id}`)
	}
	return element
}

const dropZone = requireElement('drop-zone', HTMLElement)
const fileInput = requireElement('file-input', HTMLInputElement)
const fileList = requireElement('file-list', HTMLElement)

function showFiles(files: FileList | null): void {
	fileList.replaceChildren()
	if (files === null) {
		return
	}
	for (const file of files) {
		const item = document.createElement('li')
		item.textContent = file.name
		fileList.append(item)
	}
}

fileInput.addEventListener('change', () => {
	showFiles(fileInput.files)
})

dropZone.addEventListener('dragover', (event) => {
	event.preventDefault()
	dropZone.classList.add('drag-over')
})

dropZone.addEventListener('dragleave', () => {
	dropZone.classList.remove('drag-over')
})

dropZone.addEventListener('drop', (event) => {
	event.preventDefault()
	dropZone.classList.remove('drag-over')
	showFiles(event.dataTransfer?.files ?? null)
})
