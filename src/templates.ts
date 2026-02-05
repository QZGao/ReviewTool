import state from "./state";

/**
 * 評級類型與其對應的正則表達式及建議標準。
 * @returns {Record<string, { label: string, section_regex: RegExp, page_prefix?: string, suggested_criteria: string[] }>} 評級類型映射
 */
export function assessments(): Record<string, {
	label: string,
	section_regex: RegExp,
	page_prefix?: string,
	suggested_criteria: string[]
}> {
	return {
		'bplus': {
			label: state.convByVar({ hant: '乙上級', hans: '乙上级' }),
			section_regex: /乙上?[級级]?(?:|[條条]目)[評评][審审選选級级]/,
			suggested_criteria: [
				state.convByVar({ hant: '來源', hans: '来源' }) + ' (B1)',
				state.convByVar({ hant: '覆蓋面', hans: '覆盖面' }) + ' (B2)',
				state.convByVar({ hant: '結構', hans: '结构' }) + ' (B3)',
				state.convByVar({ hant: '文筆', hans: '文笔' }) + ' (B4)',
				state.convByVar({ hant: '配圖', hans: '配图' }) + ' (B5)',
				state.convByVar({ hant: '易讀', hans: '易读' }) + ' (B6)',
				state.convByVar({ hant: '乙上級以外的建議', hans: '乙上级以外的建议' }),
			]
		}, 'good': {
			label: state.convByVar({ hant: '優良級', hans: '优良级' }),
			section_regex: /[優优]良[級级]?(?:|[條条]目)[評评][審审選选級级]/,
			page_prefix: 'Wikipedia:優良條目評選',
			suggested_criteria: [
				state.convByVar({ hant: '文筆', hans: '文笔' }) + ' (GA1)',
				state.convByVar({ hant: '來源', hans: '来源' }) + ' (GA2)',
				state.convByVar({ hant: '覆蓋面', hans: '覆盖面' }) + ' (GA3)',
				state.convByVar({ hant: '中立', hans: '中立' }) + ' (GA4) & ' + state.convByVar({
					hant: '穩定',
					hans: '稳定'
				}) + ' (GA5)', state.convByVar({ hant: '配圖', hans: '配图' }) + ' (GA6)',
				state.convByVar({ hant: '結構', hans: '结构' }) + ' (B3)',
				state.convByVar({ hant: '易讀', hans: '易读' }) + ' (B6)',
				state.convByVar({ hant: '優良級以外的建議', hans: '优良级以外的建议' })
			]
		}, 'a': {
			label: state.convByVar({ hant: '甲級', hans: '甲级' }),
			section_regex: /甲[級级](?:|[條条]目)[評评][審审選选級级]/,
			suggested_criteria: [
				state.convByVar({ hant: '來源', hans: '来源' }) + ' (A1)',
				state.convByVar({ hant: '覆蓋面', hans: '覆盖面' }) + ' (A2)',
				state.convByVar({ hant: '結構', hans: '结构' }) + ' (A3)',
				state.convByVar({ hant: '文筆', hans: '文笔' }) + ' (A4)',
				state.convByVar({ hant: '配圖', hans: '配图' }) + ' (A5)',
				state.convByVar({ hant: '易讀', hans: '易读' }) + ' (A6)',
				state.convByVar({ hant: '甲級以外的建議', hans: '甲级以外的建议' }),
			]
		}, 'featured': {
			label: state.convByVar({ hant: '典範級', hans: '典范级' }),
			section_regex: /典[範范][級级]?(?:|[條条]目)[評评][審审選选級级]/,
			page_prefix: 'Wikipedia:典范条目评选',
			suggested_criteria: [
				state.convByVar({ hant: '文筆', hans: '文笔' }) + ' (FA1a)',
				state.convByVar({ hant: '覆蓋面', hans: '覆盖面' }) + ' (FA1b)',
				state.convByVar({ hant: '來源', hans: '来源' }) + ' (FA1c)',
				state.convByVar({ hant: '中立', hans: '中立' }) + ' (FA1d) & ' + state.convByVar({
					hant: '穩定',
					hans: '稳定'
				}) + ' (FA1e)', state.convByVar({ hant: '格式', hans: '格式' }) + ' (FA2)',
				state.convByVar({ hant: '結構', hans: '结构' }) + ' (FA2b)',
				state.convByVar({ hant: '配圖', hans: '配图' }) + ' (FA3)',
				state.convByVar({ hant: '長度', hans: '长度' }) + ' (FA4)',
				state.convByVar({ hant: '易讀', hans: '易读' }) + ' (A6)',
				state.convByVar({ hant: '典範級以外的建議', hans: '典范级以外的建议' }),
			]
		}, 'featured_list': {
			label: state.convByVar({ hant: '特色列表級', hans: '特色列表级' }),
			section_regex: /特色列表[級级]?(?:|[條条]目)[評评][審审選选級级]/,
			page_prefix: 'Wikipedia:特色列表評选',
			suggested_criteria: [
				state.convByVar({ hant: '文筆', hans: '文笔' }) + ' (FL1)',
				state.convByVar({ hant: '序言', hans: '序言' }) + ' (FL2)',
				state.convByVar({ hant: '覆蓋面', hans: '覆盖面' }) + ' (FL3a)',
				state.convByVar({ hant: '長度', hans: '长度' }) + ' (FL3b)',
				state.convByVar({ hant: '結構', hans: '结构' }) + ' (FL4)',
				state.convByVar({ hant: '格式', hans: '格式' }) + ' (FL5a)',
				state.convByVar({ hant: '配圖', hans: '配图' }) + ' (FL5b)',
				state.convByVar({ hant: '穩定', hans: '稳定' }) + ' (FL6)',
				state.convByVar({ hant: '特色列表級以外的建議', hans: '特色列表级以外的建议' }),
			]
		}
	};
}

export const supplementarySectionTitleRegexes: RegExp[] = [
	/建[議议]/,
	/重新?[評评][級级]?/
];

/**
 * 獲取所有評級類型與正則表達式的映射。
 * @returns {Record<string, RegExp>} 評級類型與正則表達式的映射
 */
export function getSectionRegexes(): Record<string, RegExp> {
	const regexes: Record<string, RegExp> = {};
	for (const [key, assessment] of Object.entries(assessments())) {
		regexes[key] = assessment.section_regex;
	}
	return regexes;
}

/**
 * 獲取所有評級類型與其標籤的映射。
 * @returns {Record<string, string>} 評級類型與標籤的映射
 */
export function getAssessmentLabels(): Record<string, string> {
	const labels: Record<string, string> = {};
	for (const [key, assessment] of Object.entries(assessments())) {
		labels[key] = assessment.label;
	}
	return labels;
}