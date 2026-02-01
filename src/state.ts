/**
 * 全局狀態管理。
 */
class State {
	// 簡繁轉換
	convByVar = function (langDict: { hant: string, hans: string }): string {
		if (langDict && langDict.hant) {
			return langDict.hant; // 預設返回繁體中文
		}
		return "繁簡轉換未初始化，且 langDict 無效！";
	};
	initHanAssist(): JQuery.Promise<void> {
		return mw.loader.using('ext.gadget.HanAssist').then((require) => {
			const { convByVar } = require('ext.gadget.HanAssist') as { convByVar: (langDict: { hant: string, hans: string }) => string };
			if (typeof convByVar === 'function') {
				this.convByVar = convByVar;
			}
		});
	}

	// 當前條目標題
	articleTitle = '';

	// 是否在Talk名字空間
	inTalkPage = false;

	// 評級類型
	assessmentType = '';

	// 用戶名
	readonly userName = mw.config.get('wgUserName') || 'Example';

	// MediaWiki API 實例
	private _api: mw.Api | null = null;
	getApi() {
		if (!this._api) {
			this._api = new mw.Api({
				ajax: {
					headers: { 'Api-User-Agent': 'ReviewTool/1.0' }
				}
			});
		}
		return this._api;
	}

	// When a heading's review button is clicked, store the heading element here so
	// dialogs can determine which section to operate on.
	pendingReviewHeading: Element | null = null;

	// 批註模式狀態
	private annotationModeState: { [headingTitle: string]: boolean } = {};
	isAnnotationModeActive(headingTitle: string): boolean {
		return !!this.annotationModeState[headingTitle];
	}
	toggleAnnotationModeState(headingTitle: string): void {
		const currentState = this.isAnnotationModeActive(headingTitle);
		this.annotationModeState[headingTitle] = !currentState;
	}
}

export const state = new State();
export default state;