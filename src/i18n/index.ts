import { Language, Locale } from './types';
import { en } from './locales/en';
import { ru } from './locales/ru';

const localeMap: Record<'en' | 'ru', Locale> = {
	en,
	ru,
};

export type TranslationParams = Record<string, string | number>;

export class I18n {
	private static instance: I18n | null = null;
	private currentLang: Language = 'auto';
	private locale: Locale = en;
	private pluginName = 'Folder Bridge';

	static getInstance(): I18n {
		if (!I18n.instance) {
			I18n.instance = new I18n();
		}
		return I18n.instance;
	}

	init(settingsLanguage: Language, pluginName?: string): void {
		this.currentLang = settingsLanguage;
		if (pluginName) {
			this.pluginName = pluginName;
		}

		if (settingsLanguage === 'auto') {
			const navigatorLang = typeof navigator !== 'undefined' ? navigator.language : 'en';
			this.locale = navigatorLang.toLowerCase().startsWith('ru') ? ru : en;
		} else {
			this.locale = localeMap[settingsLanguage] ?? en;
		}
	}

	t(key: string, params?: TranslationParams): string {
		const template = this.locale[key] ?? en[key] ?? key;
		const withPluginName = template.split('<pluginName>').join(this.pluginName);
		if (!params) return withPluginName;

		return withPluginName.replace(/\{(\w+)\}/g, (match: string, name: string) => {
			const value = params[name];
			return value !== undefined ? String(value) : match;
		});
	}

	getCurrentLanguage(): Language {
		return this.currentLang;
	}
}

export const i18n = I18n.getInstance();