import { App, Modal, Setting, Notice, Platform } from 'obsidian';
import { logger } from '../logger';
import { i18n } from '../i18n';

/** Result of conflict resolution decision */
export type ConflictResolution = 'skip' | 'overwrite' | 'skipAll' | 'overwriteAll';

/**
 * ConflictResolutionModal shows a dialog when a file/folder already exists
 * at the destination during copy/move operations.
 *
 * Returns the user's resolution decision.
 */
export class ConflictResolutionModal extends Modal {
	private fileName: string;
	private operation: 'copy' | 'move';
	private onChoose: (resolution: ConflictResolution) => void;

	/**
	 * Factory method to show the modal.
	 * @returns Promise resolving to the user's decision.
	 */
	static async show(
		app: App,
		fileName: string,
		operation: 'copy' | 'move',
		totalConflicts?: number,
		currentIndex?: number,
	): Promise<ConflictResolution> {
		return new Promise<ConflictResolution>((resolve) => {
			const modal = new ConflictResolutionModal(app, fileName, operation, totalConflicts, currentIndex, resolve);
			modal.open();
		});
	}

	constructor(
		app: App,
		fileName: string,
		operation: 'copy' | 'move',
		totalConflicts?: number,
		currentIndex?: number,
		onChoose?: (resolution: ConflictResolution) => void,
	) {
		super(app);
		this.fileName = fileName;
		this.operation = operation;
		this.onChoose = onChoose || (() => {});

		const opLabel = operation === 'copy' ? i18n.t('copy.op') : i18n.t('move.op');
		const conflictInfo = totalConflicts && currentIndex !== undefined
			? i18n.t('conflictResolution.currentIndex', { index: currentIndex + 1, total: totalConflicts })
			: '';

		this.titleEl.setText(i18n.t('conflictResolution.title'));

		// Description
		const descEl = this.contentEl.createDiv({ cls: 'setting-item-description' });
		descEl.appendText(
			i18n.t('conflictResolution.desc', {
				fileName,
				opLabel,
				conflictInfo,
			})
		);

		// Buttons
		new Setting(this.contentEl)
			.addButton(btn => btn
				.setButtonText(i18n.t('conflictResolution.overwrite'))
				.setCta()
				.onClick(() => {
					this.onChoose('overwrite');
					this.close();
				}))
			.addButton(btn => btn
				.setButtonText(i18n.t('conflictResolution.overwriteAll'))
				.setCta()
				.onClick(() => {
					this.onChoose('overwriteAll');
					this.close();
				}))
			.addButton(btn => btn
				.setButtonText(i18n.t('conflictResolution.skip'))
				.onClick(() => {
					this.onChoose('skip');
					this.close();
				}))
			.addButton(btn => btn
				.setButtonText(i18n.t('conflictResolution.skipAll'))
				.setWarning()
				.onClick(() => {
					this.onChoose('skipAll');
					this.close();
				}))
			.addButton(btn => btn
				.setButtonText(i18n.t('conflictResolution.cancel'))
				.setWarning()
				.onClick(() => {
					// Treat cancel as skip for this item
					this.onChoose('skip');
					this.close();
				}));
	}
}
