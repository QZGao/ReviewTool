import state from "../state";
import {
	loadCodexAndVue,
	mountApp,
	registerCodexComponents,
	removeDialogMount,
	getMountedApp
} from "../dialog";
import AnnotationEditorDialog from "./components/annotation_editor.vue";

export interface AnnotationEditorDialogOptions {
	sectionPath: string;
	sentenceText: string;
	initialOpinion?: string;
	mode?: "create" | "edit";
	allowDelete?: boolean;
}

export type AnnotationEditorDialogResult =
	| { action: "save"; opinion: string }
	| { action: "delete" }
	| { action: "cancel" };

export function openAnnotationEditorDialog(options: AnnotationEditorDialogOptions): JQuery.Promise<AnnotationEditorDialogResult> {
	const dialogOptions: Required<AnnotationEditorDialogOptions> = {
		sectionPath: options.sectionPath,
		sentenceText: options.sentenceText,
		initialOpinion: options.initialOpinion || "",
		mode: options.mode || "create",
		allowDelete: options.allowDelete ?? options.mode === "edit"
	};

	if (getMountedApp()) removeDialogMount();

	return loadCodexAndVue()
		.then(({ Vue, Codex }) => {
			return new Promise<AnnotationEditorDialogResult>((resolve) => {
				let resolved = false;
				const finalize = (result: AnnotationEditorDialogResult) => {
					if (resolved) return;
					resolved = true;
					resolve(result);
				};

				const app = Vue.createMwApp({
					render() {
						return (Vue as unknown as { h: (comp: unknown, props: Record<string, unknown>) => unknown }).h(
							AnnotationEditorDialog,
							{
								sectionPath: dialogOptions.sectionPath,
								sentenceText: dialogOptions.sentenceText,
								initialOpinion: dialogOptions.initialOpinion,
								mode: dialogOptions.mode,
								allowDelete: dialogOptions.allowDelete,
								onResolve: finalize
							}
						);
					}
				});

				registerCodexComponents(app, Codex);
				mountApp(app);
			});
		})
		.catch((error) => {
			console.error("[ReviewTool] Failed to open annotation editor dialog", error);
			if (mw && mw.notify) {
				mw.notify(state.convByVar({ hant: "無法開啟批註對話框。", hans: "无法开启批注对话框。" }), {
					type: "error",
					title: "[ReviewTool]"
				});
			}
			throw error;
		});
}
