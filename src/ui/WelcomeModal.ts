import { App, Modal, Setting } from 'obsidian';
import { i18n } from '../i18n';

/**
 * First-run welcome modal shown once when Folder Bridge is loaded with no
 * mounts configured.  Gives new users a quick orientation and a direct path
 * to adding their first mount without having to hunt through Settings.
 */
export class WelcomeModal extends Modal {
	private onAddMount: () => void;
	private onDismiss: () => void;

	constructor(app: App, onAddMount: () => void, onDismiss: () => void) {
		super(app);
		this.onAddMount = onAddMount;
		this.onDismiss = onDismiss;
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.empty();

		contentEl.createEl('h2', { text: i18n.t('welcome.title') });

		const descEl = contentEl.createDiv({ cls: 'folderbridge-welcome-desc' });

		descEl.createEl('p', {
			text: i18n.t('welcome.intro'),
		}).addClass('folderbridge-welcome-intro');

		descEl.createEl('p', { text: i18n.t('welcome.features') }).addClass('folderbridge-welcome-intro');

		const list = descEl.createEl('ul', { cls: 'folderbridge-feature-list' });
		for (const item of [
			i18n.t('welcome.feature.local'),
			i18n.t('welcome.feature.webdav'),
			i18n.t('welcome.feature.vault'),
		]) {
			list.createEl('li', { text: item, cls: 'folderbridge-feature-item' });
		}

		descEl.createEl('p', {
			text: i18n.t('welcome.expanded'),
			cls: 'setting-item-description',
		});

		const tipBox = contentEl.createDiv({ cls: 'folderbridge-tip-box' });
		tipBox.appendText(i18n.t('welcome.tip'));

		new Setting(contentEl)
			.addButton(btn => btn
				.setButtonText(i18n.t('welcome.btnAdd'))
				.setCta()
				.onClick(() => {
					this.close();
					this.onAddMount();
				}))
			.addButton(btn => btn
				.setButtonText(i18n.t('welcome.btnExplore'))
				.onClick(() => {
					this.close();
					this.onDismiss();
				}));
	}

	onClose(): void {
		this.contentEl.empty();
	}
}
