import os
#os.environ['REQUESTS_CA_BUNDLE'] = 'leaf.pem'
os.environ['REQUESTS_CA_BUNDLE'] = 'ca.pem'
import requests
import json
from dotenv import dotenv_values
env = dotenv_values('.env')

MODEL_ENDPOINT = env.get("MODEL_ENDPOINT")
API_PATH = "/v1/chat/completions"
AUTH_TOKEN = env.get("API_KEY")
BODY_DATA = {
    #"model": "Qwen/Qwen3-VL-30B-Thinking",
    "messages": [
        {
            "role": "user",
            "content":
            [
                {
                    "type": "text",
                    "text": "Describe this image in one sentence."
                },
                {
                    "type": "image_url",
                    "image_url": {
                        "url": "https://cdn.britannica.com/61/93061-050-99147DCE/Statue-of-Liberty-Island-New-York-Bay.jpg"
                    }
                }
            ]
        }
    ]
}


headers = {
    "Content-Type": "application/json",
    "Authorization": f"Bearer {AUTH_TOKEN}",
}

#response = requests.post(f"{MODEL_ENDPOINT}{API_PATH}", headers=headers, data=json.dumps(BODY_DATA), verify="/Users/zziang/Documents/projects/vibeCoding/Agents/llm_evaluation/qwen30-vl-30b-fp8/ca.pem")
response = requests.post(f"{MODEL_ENDPOINT}{API_PATH}", headers=headers, data=json.dumps(BODY_DATA), verify=False)

print(response.text)


API_PATH = "/v1/models"
response = requests.get(f"{MODEL_ENDPOINT}{API_PATH}", headers=headers, verify=False)
print(response.text)
