import type { AppLocale, LocalizedText } from '../../src/types/app';

export const ID_MAX_LENGTH: number;
export function isPackageRelativePath(value: unknown): value is string;
export function parseLocalizedText(value: unknown, field: string, options: { required: true; max?: number }): LocalizedText;
export function parseLocalizedText(value: unknown, field: string, options?: { required?: boolean; max?: number }): LocalizedText | undefined;
export function resolveLocalizedText(text: LocalizedText | undefined, locale: AppLocale): string;
