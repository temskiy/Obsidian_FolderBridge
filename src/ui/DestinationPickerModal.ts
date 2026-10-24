import { App, SuggestModal, Notice, TFile, TFolder, TAbstractFile, normalizePath } from 'obsidian';
import { MountPoint } from '../types';
import { DestinationOption, getAvailableDestinations, getMountTypeLabel } from '../FileTransfer';
import { logger } from '../logger';
import { i18n } from '../i18n';

/**
 * DestinationPickerModal lets the user choose a destination for copy/move
 * operations from a fuzzy-searchable list of vault + active mounts.
 */
export class DestinationPickerModal extends SuggestModal<DestinationOption> {
	private plugin: any; // FolderBridgePlugin
	private operation: 'copy' | 'move';
	private sourceFile: TAbstractFile;
	private onChoose: (dest: DestinationOption) => Promise<void>;

	constructor(
		app: App,
		plugin: any,
		sourceFile: TAbstractFile,
		operation: 'copy' | 'move',
		onChoose: (dest: DestinationOption) => Promise<void>,
	) {
		super(app);
		this.plugin = plugin;
		this.sourceFile = sourceFile;
		this.operation = operation;
		this.onChoose = onChoose;

		const opLabel = operation === 'copy' ? i18n.t('menu.copyTo') : i18n.t('menu.moveTo');
		this.setPlaceholder(i18n.t('destinationPicker.placeholder'));
		this.setTitle(`${opLabel} "${sourceFile.name}"`);
	}

	getSuggestions(query: string): DestinationOption[] {
		const destinations = getAvailableDestinations(
			this.plugin.settings.mountPoints,
			this.plugin.mountHealthMap,
		);

		const q = query.toLowerCase();
		return destinations.filter(dest => {
			if (!q) return true;
			return (
				dest.name.toLowerCase().includes(q) ||
				dest.type.toLowerCase().includes(q) ||
				dest.id.toLowerCase().includes(q)
			);
		});
	}

	renderSuggestion(item: DestinationOption, el: HTMLElement): void {
		const container = el.createEl('div', { cls: 'destination-suggestion' });
		container.createEl('span', { text: `${item.name} (${getMountTypeLabel(item.type)})`, cls: 'destination-name' });
	}

	getOptionText(item: DestinationOption): string {
		return `${item.name} (${getMountTypeLabel(item.type)})`;
	}

	async onChooseSuggestion(item: DestinationOption): Promise<void> {
		await this.onChoose(item);
	}
}
