const debug = require('debug')('codeceptjs:reportportal');
const { event, recorder, output, container } = codeceptjs;
const { clearString } = require('codeceptjs/lib/utils');
const sleep = require('sleep-promise');
const {
	screenshotHelpers,
	PREFIX_PASSED_STEP,
	PREFIX_SKIPPED_TEST,
	PREFIX_FAILED_TEST,
	PREFIX_PASSED_TEST,
	PREFIX_FAILED_STEP,
	PREFIX_BUG,
} = require('./constants/codeceptjsTypes');
const { STATUSES } = require('./constants/statuses');
const { TEST_ITEM_TYPES } = require('./constants/testItemTypes');
const { LOG_LEVELS } = require('./constants/logLevels');
const {
	startLaunch,
	getRPLink,
	writePRInfo,
	startTestItem,
	logCurrent,
	finishStepItem,
	sendLogToRP,
	attachScreenshot,
	finishLaunch,
	attachVideo,
	attachTrace,
} = require('./helpers/rpHelpers');
const { finishTestItem } = require('./helpers/rpHelpers');
const { version } = require('./package.json');
const deepMerge = require('lodash.merge');
const logToFile = require('./helpers/logging');

const helpers = container.helpers();
let helper;

for (const helperName of screenshotHelpers) {
	if (Object.keys(helpers).indexOf(helperName) > -1) {
		helper = helpers[helperName];
	}
}

const defaultConfig = {
	token: '',
	endpoint: '',
	projectName: '',
	launchName: 'codeceptjs tests',
	launchDescription: '',
	launchAttributes: [
		{
			key: 'platform',
			value: process.platform,
		},
		{
			key: 'rphelper-version',
			value: version,
		},
	],
	debug: false,
	rerun: undefined,
	enabled: false,
};

const requiredFields = ['projectName', 'token', 'endpoint'];

module.exports = (passedConfig) => {
	const config = deepMerge(defaultConfig, passedConfig);

	for (const field of requiredFields) {
		if (!config[field])
			throw new Error(
				`ReportPortal config is invalid. Key ${field} is missing in config.\nRequired fields: ${requiredFields} `,
			);
	}

	let launchObj;
	let suiteObj;
	let testObj;
	let launchStatus = STATUSES.PASSED;
	let currentMetaSteps = [];
	const suiteArr = new Set();
	let testArr = [];
	const testResults = {
		suites: [],
		tests: {
			passed: [],
			failed: [],
			skipped: [],
		},
	};

	let currenTestTitle;
	let currentSuiteTitle;

	event.dispatcher.on(event.suite.before, async (suite) => {
		await recorder.add(async () => {
			testResults.suites.push(suite);
			const message = `Suite started: ${suite.title}`;
			debug(message);
			logToFile(message);
		});
	});

	event.dispatcher.on(event.test.failed, async (test, err) => {
		await recorder.add(async () => {
			if (!process.env.RUNS_WITH_WORKERS) {
				testResults.tests.failed.push(test);
			}
			const message = `Test failed: ${test.title} - Error: ${err.stack || err}`;
			debug(message);
			logToFile(message);
		});
	});

	event.dispatcher.on(event.test.passed, async (test) => {
		await recorder.add(async () => {
			if (!process.env.RUNS_WITH_WORKERS) {
				testResults.tests.passed.push(test);
			}
			const message = `Test passed: ${test.title}`;
			debug(message);
			logToFile(message);
		});
	});

	event.dispatcher.on(event.all.result, async () => {
		await recorder.add(async () => {
			if (!process.env.RUNS_WITH_WORKERS) {
				debug('Finishing launch...');
				logToFile('Finishing launch...');
				await _sendResultsToRP(testResults);
			}
		});
	});

	event.dispatcher.on(event.workers.result, async (result) => {
		await recorder.add(async () => {
			await _sendResultsToRP(result);
		});
	});

	async function _sendResultsToRP(result) {
		for (suite of result.suites) {
			suiteArr.add(suite.title);
		}
		testArr = result.tests;

		try {
			launchObj = await startLaunch(config);
			try {
				const launchId = (await launchObj.promise).id;
				const launchLink = await getRPLink(config, launchId);
				writePRInfo(launchLink, config);

				const suiteTempIdArr = [];
				const testTempIdArr = [];

				for (suite of suiteArr) {
					suiteObj = await startTestItem(
						launchObj.tempId,
						suite,
						TEST_ITEM_TYPES.SUITE,
					);
					suiteObj.status =
						testArr.failed.length > 0 ? STATUSES.FAILED : STATUSES.PASSED;
					suiteTempIdArr.push({
						suiteTitle: suite,
						suiteTempId: suiteObj.tempId,
					});
					currentSuiteTitle = suite;
					await finishStepItem(suiteObj);
					logToFile(`Suite finished: ${suite} - Status: ${suiteObj.status}`);
				}

				for (test of testArr.passed) {
					currenTestTitle = test.title;
					testObj = await startTestItem(
						launchObj.tempId,
						test.title,
						TEST_ITEM_TYPES.TEST,
						suiteTempIdArr.find(
							(element) => element.suiteTitle === test.parent.title,
						).suiteTempId,
						currentSuiteTitle,
					);
					testObj.status = STATUSES.PASSED;

					testTempIdArr.push({
						testTitle: test.title,
						testTempId: testObj.tempId,
						testError: test.err,
						testSteps: test.steps,
					});

					const message = `${PREFIX_PASSED_TEST} - ${test.title}`;
					await sendLogToRP({
						tempId: testObj.tempId,
						level: LOG_LEVELS.INFO,
						message,
					});
					await finishTestItem(testObj);
					logToFile(`Test passed: ${test.title}`);
				}

				for (test of testArr.failed) {
					currenTestTitle = test.title;
					testObj = await startTestItem(
						launchObj.tempId,
						test.title,
						TEST_ITEM_TYPES.TEST,
						suiteTempIdArr.find(
							(element) => element.suiteTitle === test.parent.title,
						).suiteTempId,
						currentSuiteTitle,
					);
					testObj.status = STATUSES.FAILED;
					launchStatus = STATUSES.FAILED;

					testTempIdArr.push({
						testTitle: test.title,
						testTempId: testObj.tempId,
						testError: test.err,
						testSteps: test.steps,
						testArtifacts: test.artifacts,
					});

					const message = `${PREFIX_FAILED_TEST} - ${test.title}\n${
						test.err.stack ? test.err.stack : JSON.stringify(test.err)
					}`;
					await sendLogToRP({
						tempId: testObj.tempId,
						level: LOG_LEVELS.ERROR,
						message,
					});
					await finishTestItem(testObj, config.issue);
					logToFile(`Test failed: ${test.title} - Error: ${message}`);
				}

				for (test of testArr.skipped) {
					currenTestTitle = test.title;
					testObj = await startTestItem(
						launchObj.tempId,
						test.title,
						TEST_ITEM_TYPES.TEST,
						suiteTempIdArr.find(
							(element) => element.suiteTitle === test.parent.title,
						).suiteTempId,
						currentSuiteTitle,
					);
					testObj.status = STATUSES.SKIPPED;

					testTempIdArr.push({
						testTitle: test.title,
						testTempId: testObj.tempId,
						testError: test.err,
						testSteps: test.steps,
					});

					const message = `${PREFIX_SKIPPED_TEST} - ${test.title}`;
					await sendLogToRP({
						tempId: testObj.tempId,
						level: LOG_LEVELS.INFO,
						message,
					});
					await finishTestItem(testObj);
					logToFile(`Test skipped: ${test.title}`);
				}

				for (test of testTempIdArr) {
					for (step of test.testSteps) {
						if (!step) {
							debug(`The ${test.testTitle} has no steps.`);
							logToFile(`The ${test.testTitle} has no steps.`);
							break;
						}
						const stepArgs = step.agrs ? step.agrs : step.args;
						const prefix =
							step.status === STATUSES.FAILED
								? PREFIX_FAILED_STEP
								: PREFIX_PASSED_STEP;
						const stepTitle = stepArgs
							? `${prefix}: ${step.actor} ${step.name} ${JSON.stringify(
									stepArgs
										.map((item) =>
											item?._secret ? '*****' : JSON.stringify(item),
										)
										.join(' '),
							  )}`
							: `${prefix}: - ${step.actor} ${step.name}`;

						await sleep(1);
						const stepObj = await startTestItem(
							launchObj.tempId,
							stepTitle.slice(0, 300),
							TEST_ITEM_TYPES.STEP,
							test.testTempId,
							currenTestTitle,
						);

						stepObj.status =
							step.status === STATUSES.FAILED
								? STATUSES.FAILED
								: STATUSES.PASSED;

						if (stepObj.status === STATUSES.FAILED) {
							let stepMessage;
							if (step.test?.err) {
								stepMessage = `${PREFIX_BUG}: ${JSON.stringify(
									step.test.err,
									null,
									2,
								)}`;
							} else if (step.err) {
								stepMessage = `${PREFIX_BUG}: ${
									step.err.stack ? step.err.stack : JSON.stringify(step.err)
								}`;
							} else if (step.helper.currentRunningTest.err) {
								stepMessage = `${PREFIX_BUG}: ${JSON.stringify(
									step.helper.currentRunningTest.err,
								)}`;
							}
							await sendLogToRP({
								tempId: stepObj.tempId,
								level: LOG_LEVELS.ERROR,
								message: stepMessage,
							});

							if (helper) {
								let screenshot;

								if (test.testArtifacts?.screenshot) {
									screenshot = await attachScreenshot(
										helper,
										test.testArtifacts.screenshot,
									);
								} else {
									screenshot = await attachScreenshot(
										helper,
										`${clearString(test.testTitle)}.failed.png`,
									);
								}

								await sendLogToRP({
									tempId: stepObj.tempId,
									level: LOG_LEVELS.DEBUG,
									message: '📷 Last seen screenshot',
									screenshotData: screenshot,
								});

								if (test.testArtifacts?.video) {
									const recordedVideo = await attachVideo(
										test.testArtifacts.video,
									);

									await sendLogToRP({
										tempId: stepObj.tempId,
										level: LOG_LEVELS.DEBUG,
										message: '🎥 Last recorded video',
										screenshotData: recordedVideo,
									});
								}

								if (test.testArtifacts?.video) {
									const trace = await attachTrace(test.testArtifacts.trace);

									await sendLogToRP({
										tempId: stepObj.tempId,
										level: LOG_LEVELS.DEBUG,
										message: '🕵 Trace',
										screenshotData: trace,
									});
								}
							}
							logToFile(`Step failed: ${stepTitle} - Error: ${stepMessage}`);
						} else {
							logToFile(`Step passed: ${stepTitle}`);
						}

						await finishStepItem(stepObj);
					}
				}

				await finishLaunch(launchObj, launchStatus);
				logToFile(`Launch finished with status: ${launchStatus}`);
			} catch (e) {
				logToFile(`Could not start launch due to: ${e.message}`);
			}
		} catch (e) {
			logToFile(`Could not start launch due to: ${e.message}`);
		}
	}

	async function startMetaSteps(step, parentTitle) {
		let metaStepObj = {};
		const metaSteps = metaStepsToArray(step.metaStep);

		// close current metasteps
		for (let j = currentMetaSteps.length - 1; j >= metaSteps.length; j--) {
			await finishStep(currentMetaSteps[j]);
			logToFile(`Closing metastep: ${currentMetaSteps[j].toString()}`);
		}

		for (const i in metaSteps) {
			const metaStep = metaSteps[i];
			if (isEqualMetaStep(metaStep, currentMetaSteps[i])) {
				metaStep.tempId = currentMetaSteps[i].tempId;
				continue;
			}
			// close metasteps other than current
			for (let j = currentMetaSteps.length - 1; j >= i; j--) {
				await finishStep(currentMetaSteps[j]);
				logToFile(`Closing metastep: ${currentMetaSteps[j].toString()}`);
				delete currentMetaSteps[j];
			}

			metaStepObj = currentMetaSteps[i - 1] || metaStepObj;

			const isNested = !!metaStepObj.tempId;
			metaStepObj = startTestItem(
				launchObj.tempId,
				metaStep.toString(),
				TEST_ITEM_TYPES.STEP,
				metaStepObj.tempId || testObj.tempId,
				parentTitle,
			);
			metaStep.tempId = metaStepObj.tempId;
			debug(
				`${
					metaStep.tempId
				}: The stepId '${metaStep.toString()}' is started. Nested: ${isNested}`,
			);
			logToFile(
				`Metastep started: ${metaStep.toString()} - Nested: ${isNested}`,
			);
		}

		currentMetaSteps = metaSteps;
		return currentMetaSteps[currentMetaSteps.length - 1] || testObj;
	}

	function finishStep(step) {
		if (!step.tempId) {
			debug(
				`WARNING: '${step.toString()}' step can't be closed, it has no tempId`,
			);
			return;
		}
		debug(`Finishing '${step.toString()}' step`);

		return finishStepItem(step);
	}

	return {
		addLog: logCurrent,
	};
};

function metaStepsToArray(step) {
	const metaSteps = [];
	iterateMetaSteps(step, (metaStep) => metaSteps.push(metaStep));
	return metaSteps;
}

function iterateMetaSteps(step, fn) {
	if (step?.metaStep) iterateMetaSteps(step.metaStep, fn);
	if (step) fn(step);
}

const isEqualMetaStep = (metastep1, metastep2) => {
	if (!metastep1 && !metastep2) return true;
	if (!metastep1 || !metastep2) return false;
	return (
		metastep1.actor === metastep2.actor &&
		metastep1.name === metastep2.name &&
		metastep1.args.join(',') === metastep2.args.join(',')
	);
};
