// debug-api.js - Test Groq connectivity
import dotenv from 'dotenv';
import Groq from 'groq-sdk';

dotenv.config();

console.log('=== GROQ API DEBUG ===');
console.log('API Key exists:', !!process.env.GROQ_API_KEY);
console.log('API Key prefix:', process.env.GROQ_API_KEY?.substring(0, 15) + '...');
console.log('API Key length:', process.env.GROQ_API_KEY?.length);

if (!process.env.GROQ_API_KEY) {
  console.error('\n❌ ERROR: GROQ_API_KEY not found in environment!');
  console.log('\nSolutions:');
  console.log('1. Create .env file in backend directory:');
  console.log('   GROQ_API_KEY=gsk_your_actual_key_here');
  console.log('2. Or export it: export GROQ_API_KEY="gsk_your_actual_key_here"');
  process.exit(1);
}

const groq = new Groq({ 
  apiKey: process.env.GROQ_API_KEY 
});

async function testSimpleCall() {
  console.log('\n--- Testing Simple API Call ---');
  try {
    const response = await groq.chat.completions.create({
      model: 'llama-3.3-70b-versatile',
      messages: [{ role: 'user', content: 'Say "API works" and nothing else.' }],
      max_tokens: 20,
    });
    console.log('✅ SUCCESS!');
    console.log('Response:', response.choices[0].message.content);
    return true;
  } catch (error) {
    console.error('❌ FAILED:', error.message);
    if (error.status) console.error('HTTP Status:', error.status);
    if (error.error) console.error('Error details:', error.error);
    return false;
  }
}

async function testWithTool() {
  console.log('\n--- Testing Tool/Function Call ---');
  try {
    const response = await groq.chat.completions.create({
      model: 'llama-3.3-70b-versatile',
      messages: [{ role: 'user', content: 'Extract keyword "Python" from this text: "I know Python and JavaScript"' }],
      max_tokens: 100,
      tools: [{
        type: 'function',
        function: {
          name: 'submit_keyword',
          parameters: {
            type: 'object',
            properties: {
              keyword: { type: 'string' }
            }
          }
        }
      }],
      tool_choice: { type: 'function', function: { name: 'submit_keyword' } }
    });
    
    console.log('✅ Tool call SUCCESS!');
    console.log('Has tool_calls:', !!response.choices[0]?.message?.tool_calls);
    return true;
  } catch (error) {
    console.error('❌ Tool call FAILED:', error.message);
    return false;
  }
}

async function main() {
  const simpleOk = await testSimpleCall();
  if (simpleOk) {
    await testWithTool();
  }
}

main();