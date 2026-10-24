import { App, Modal, Setting } from 'obsidian';
import { logger } from '../logger';
import { i18n } from '../i18n';

export class MountRootDeleteModal extends Modal {
    private resolve: (value: 'unmount' | 'delete' | 'unmount-always' | 'delete-always' | 'cancel') => void | Promise<void>;
    private dontAskAgain = false;
    private resolved = false;

    constructor(app: App, private mountPath: string, resolve: (value: 'unmount' | 'delete' | 'unmount-always' | 'delete-always' | 'cancel') => void | Promise<void>) {
        super(app);
        this.resolve = resolve;
    }

    private settle(value: 'unmount' | 'delete' | 'unmount-always' | 'delete-always' | 'cancel'): void {
        void Promise.resolve(this.resolve(value)).catch(error => {
            logger.error('Folder Bridge: Mount root delete callback failed', error);
        });
    }

    onOpen() {
        const { contentEl } = this;
        contentEl.empty();
        contentEl.createEl('h2', { text: i18n.t('mountDelete.title') });

        contentEl.createEl('p', {
            text: i18n.t('mountDelete.desc1', { path: this.mountPath })
        });

        contentEl.createEl('p', {
            text: i18n.t('mountDelete.desc2')
        });

        new Setting(contentEl)
            .setName(i18n.t('mountDelete.dontAsk'))
            .setDesc(i18n.t('mountDelete.dontAsk.desc'))
            .addToggle(toggle => toggle
                .setValue(this.dontAskAgain)
                .onChange(value => {
                    this.dontAskAgain = value;
                })
            );
        const buttonContainer = contentEl.createDiv({ cls: 'folderbridge-modal-buttons' });

        const btnCancel = buttonContainer.createEl('button', { text: i18n.t('button.cancel') });
        btnCancel.onclick = () => {
            if (!this.resolved) {
                this.resolved = true;
                this.settle('cancel');
                this.close();
            }
        };

        const btnUnmount = buttonContainer.createEl('button', { text: i18n.t('mountDelete.unmount') });
        btnUnmount.onclick = () => {
            if (!this.resolved) {
                this.resolved = true;
                this.settle(this.dontAskAgain ? 'unmount-always' : 'unmount');
                this.close();
            }
        };

        const btnDelete = buttonContainer.createEl('button', { text: i18n.t('mountDelete.delete'), cls: 'mod-warning' });
        btnDelete.onclick = () => {
            if (!this.resolved) {
                this.resolved = true;
                this.settle(this.dontAskAgain ? 'delete-always' : 'delete');
                this.close();
            }
        };
    }

    onClose() {
        const { contentEl } = this;
        contentEl.empty();
        if (!this.resolved) {
            this.resolved = true;
            this.settle('cancel');
        }
    }
}
