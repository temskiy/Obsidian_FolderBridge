import { App, Modal, Setting, Notice } from 'obsidian';
import { MountPoint } from '../types';
import { formatSizeBytes, getMountTypeLabel } from '../FileTransfer';
import { logger } from '../logger';
import { i18n } from '../i18n';

/** Operation type for the warning modal. */
export type LargeFileOperation = 'create' | 'copy' | 'move';

/**
 * LargeFileWarningModal shows a confirmation dialog when the user is about
 * to create, copy, or move a large file/folder into a mount with large-file
 * warnings enabled.
 *
 * Returns true if the user confirmed, false if cancelled.
 * If the user chooses "Disable warnings", the mount's enableLargeFileConfirm
 * is set to false via the provided onSave callback.
 */
export class LargeFileWarningModal extends Modal {
	private fileName: string;
	private sizeKB: number;
	private mount: MountPoint;
	private operation: LargeFileOperation;
	private onSave?: (mount: MountPoint) => Promise<void>;

	/**
	 * Factory method to show the modal.
	 * @returns Promise resolving to true if confirmed, false if cancelled.
	 */
	static async show(
		app: App,
		fileName: string,
		sizeKB: number,
		mount: MountPoint,
		operation: LargeFileOperation,
		onSave?: (mount: MountPoint) => Promise<void>,
	): Promise<boolean> {
		return new Promise<boolean>((resolve) => {
			const modal = new LargeFileWarningModal(app, fileName, sizeKB, mount, operation, onSave);
			modal.open();

			// Override closeModal to resolve with false (cancelled)
			const originalClose = modal.close.bind(modal);
			modal.close = () => {
				resolve(false);
				originalClose();
			};

			// Store resolve for confirmation
			(modal as unknown as { _resolve: (value: boolean) => void })._resolve = resolve;
		});
	}

	constructor(
		app: App,
		fileName: string,
		sizeKB: number,
		mount: MountPoint,
		operation: LargeFileOperation,
		onSave?: (mount: MountPoint) => Promise<void>,
	) {
		super(app);
		this.fileName = fileName;
		this.sizeKB = sizeKB;
		this.mount = mount;
		this.operation = operation;
		this.onSave = onSave;

		const operationLabel = this.getOperationLabel();
		const sizeLabel = formatSizeBytes(sizeKB * 1024);
		const mountLabel = mount.label || mount.virtualPath || i18n.t('largeFileWarning.mountFallback', { id: mount.id });
		const mountTypeLabel = getMountTypeLabel(mount.mountType ?? 'local');

		this.titleEl.setText(i18n.t('largeFileWarning.title'));

		// Description
		const descEl = this.contentEl.createDiv({ cls: 'setting-item-description' });
		descEl.appendText(
			i18n.t('largeFileWarning.desc', {
				op: operationLabel,
				fileName,
				sizeLabel,
				mountLabel,
				mountTypeLabel,
			})
		);

		// Buttons
		new Setting(this.contentEl)
			.addButton(btn => btn
				.setButtonText(i18n.t('largeFileWarning.confirm'))
				.setCta()
				.onClick(() => {
					(this as unknown as { _resolve: (value: boolean) => void })._resolve(true);
					this.close();
				}))
			.addButton(btn => btn
				.setButtonText(i18n.t('largeFileWarning.disable'))
				.setWarning()
				.onClick(async () => {
					try {
						this.mount.enableLargeFileConfirm = false;
						await this.onSave?.(this.mount);
						new Notice(i18n.t('largeFileWarning.disabled', { mount: mount.label || mount.virtualPath }));
					} catch (error) {
						logger.error('[FolderBridge] Failed to disable large file warnings:', error);
						new Notice(i18n.t('largeFileWarning.failed'));
					}
					(this as unknown as { _resolve: (value: boolean) => void })._resolve(true);
					this.close();
				}))
			.addButton(btn => btn
				.setButtonText(i18n.t('largeFileWarning.cancel'))
				.onClick(() => {
					(this as unknown as { _resolve: (value: boolean) => void })._resolve(false);
					this.close();
				}));
	}

	private getOperationLabel(): string {
		switch (this.operation) {
			case 'create':
				return i18n.t('op.create');
			case 'copy':
				return i18n.t('copy.op');
			case 'move':
				return i18n.t('move.op');
		}
	}
}
