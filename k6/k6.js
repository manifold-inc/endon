import http from 'k6/http';
import { check } from 'k6';
import { Rate, Trend } from 'k6/metrics';
import { SharedArray } from 'k6/data';

const API_TOKEN = __ENV.API_TOKEN;

// Simplified metrics focused on throughput
const metrics = {
    requestRate: new Rate('request_rate'),           // Successful requests per second
    errorRate: new Rate('error_rate'),              // Failed requests per second
    duration: new Trend('response_duration'),        // Response time distribution
    durationByModel: new Trend('duration_by_model'), // Response time by model
};

// Test configuration
export const options = {
    scenarios: {
        stress_test: {
            executor: 'ramping-vus',
            startVUs: 1,
            stages: [
                { duration: '2m', target: 20 },   // Warm up: gradually increase to 20 VUs
                { duration: '5m', target: 100 },  // Ramp up: increase to 100 VUs
                { duration: '10m', target: 200 }, // Peak load: maintain 200 VUs
                { duration: '5m', target: 100 },  // Scale down: decrease to 100 VUs
                { duration: '3m', target: 0 },    // Ramp down: gradually stop
            ],
            gracefulRampDown: '30s',
        },
    },
    thresholds: {
        'http_req_duration': ['p(95)<5000'],  // 95% of requests should be below 5s
        'request_rate': ['rate>0.9'],         // 90% success rate
        'error_rate': ['rate<0.1'],           // Less than 10% error rate
    }
};

// Define a broader set of stop tokens or completion indicators
const COMPLETION_INDICATORS = [
    '###',
    '[DONE]',
    '$\\boxed{',  // LaTeX box endings
    'The final answer is:',
    'The answer is:',
    '\n\n'  // Double newline often indicates completion
];

// Load questions from CSV
const questions = new SharedArray('questions', function() {
    const data = open('./questions_4k.csv').split('\n');
    return data
        .map(line => {
            const [_, question] = line.split('|');
            return question;
        })
        .filter(q => q); // Remove any empty entries
});

console.log(`Loaded ${questions.length} questions`);

// Hardcoded models list
const AVAILABLE_MODELS = [
    "NousResearch/Hermes-3-Llama-3.1-8B",
    "NTQAI/Nxcode-CQ-7B-orpo",
    "nvidia/Llama-3.1-Nemotron-70B-Instruct-HF",
    "EnvyIrys/EnvyIrys_sn111_14"
];

// Remove the file handling code and simplify to just console logging
function writeLog(type, data) {
    console.log(JSON.stringify({
        timestamp: new Date().toISOString(),
        type: type,
        ...data
    }));
}

// Remove the setup/teardown of the log file
export function setup() {
    // Log initialization
    writeLog('info', { message: `Loaded ${questions.length} questions` });
    writeLog('info', { message: 'Using models:', models: AVAILABLE_MODELS });
    return { models: AVAILABLE_MODELS };
}

export default function (data) {
    if (!data || !data.models || !data.models.length) {
        writeLog('error', { message: 'No models available' });
        return;
    }

    const model = data.models[Math.floor(Math.random() * data.models.length)];
    const maxTokens = Math.floor(Math.random() * 1000);
    const question = questions[Math.floor(Math.random() * questions.length)];

    const payload = JSON.stringify({
        model: model,
        prompt: question,  // Using just the question part from the CSV
        max_tokens: maxTokens,
        stream: true
    });

    const headers = {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${API_TOKEN}`
    };

    const response = http.post('https://api.targon.com/v1/completions', payload, { headers });

    // Parse SSE response
    let responseText = '';
    let parseError = null;
    let foundStopTokens = [];
    let isValidResponse = false;

    try {
        // Split response into SSE events
        const events = response.body.split('\n\n');
        for (const event of events) {
            if (!event.trim()) continue;
            
            // Extract the data portion
            const match = event.match(/^data: (.+)$/m);
            if (!match) continue;

            try {
                const jsonData = JSON.parse(match[1]);
                if (jsonData.choices && jsonData.choices[0]) {
                    responseText += jsonData.choices[0].text || '';
                }
            } catch (e) {
                // Ignore parse errors for individual events
                continue;
            }
        }
        
        // Check for any completion indicator
        foundStopTokens = COMPLETION_INDICATORS.filter(token => responseText.includes(token));
        
        isValidResponse = response.status === 200 && 
            responseText.length > 0 && 
            (foundStopTokens.length > 0 || responseText.length > 50);  // Consider longer responses valid even without stop token

        // Update metrics based on validation
        metrics.requestRate.add(isValidResponse);
        metrics.errorRate.add(!isValidResponse);

        check(response, {
            'is_success': () => response.status === 200,
            'has_response': () => responseText.length > 0,
            'has_stop_token': () => foundStopTokens.length > 0 || responseText.length > 50,
            'response_time_ok': () => response.timings.duration < 5000
        });

        // Log the request/response data
        writeLog('request', {
            vuId: __VU,
            iterationId: __ITER,
            validation: {
                status: response.status,
                responseLength: responseText.length,
                foundStopTokens: foundStopTokens,
                hasValidResponse: responseText.length > 0,
                fullResponse: responseText,
                rawResponse: response.body
            },
            request: {
                model: model,
                maxTokens: maxTokens,
                question: question  // Full question instead of preview
            },
            metrics: {
                duration: response.timings.duration,
                waiting: response.timings.waiting,
                receiving: response.timings.receiving
            }
        });

        if (!isValidResponse) {
            writeLog('error', {
                message: 'Response validation failed',
                status: response.status,
                hasResponse: responseText.length > 0,
                responseLength: responseText.length,
                foundStopTokens: foundStopTokens,
                parseError: parseError,
                model: model,
                maxTokens: maxTokens,
                fullResponse: responseText,
                rawResponse: response.body,
                timings: {
                    total: response.timings.duration,
                    waiting: response.timings.waiting,
                    receiving: response.timings.receiving
                }
            });
        }

    } catch (e) {
        writeLog('error', {
            message: 'Response parsing failed',
            error: e.message,
            responseBody: response.body.substring(0, 200),
            status: response.status,
            headers: response.headers
        });
    }

    // Metrics and checks
    metrics.duration.add(response.timings.duration);
    metrics.durationByModel.add(response.timings.duration, { model: String(model) });
}

export function handleSummary(data) {
    // Still log to console
    writeLog('summary', { data: data });
    
    return {
        'summary.json': JSON.stringify(data, null, 2),     // Save detailed JSON summary
        'summary.txt': textSummary(data, { indent: ' ' }), // Save text summary
        'stdout': textSummary(data, { indent: ' ' }),      // Also show summary in console
    };
}