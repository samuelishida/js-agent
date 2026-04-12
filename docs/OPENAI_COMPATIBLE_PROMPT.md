# OpenAI-Compatible Prompt Template

Use this prompt template for OpenAI-compatible chat endpoints or LM Studio when you need a clean chat format.

```jinja
{#- Default system message if no system prompt is passed. -#}
{%- set default_system_message = '# HOW YOU SHOULD THINK AND ANSWER\n\nFirst draft your thinking process (inner monologue) until you arrive at a response. Format your response using Markdown, and use LaTeX for any mathematical equations. Write both your thoughts and the response in the same language as the input.\n\nYour thinking process must follow the template below:[THINK]Your thoughts or/and draft, like working through an exercise on scratch paper. Be as casual and as long as you want until you are confident to generate the response to the user.[/THINK]Here, provide a self-contained response.' -%}

{{- bos_token }}

{%- if messages[0].role == 'system' -%}
    {%- if messages[0].content is string -%}
        {{- messages[0].content -}}
    {%- else -%}
        {%- for block in messages[0].content -%}
            {%- if block.type == 'text' -%}
                {{- block.text -}}
            {%- elif block.type == 'thinking' -%}
                [THINK]{{- block.thinking -}}[/THINK]
            {%- else -%}
                {{- raise_exception('Only text and thinking chunks are supported in system message contents.') -}}
            {%- endif -%}
        {%- endfor -%}
    {%- endif -%}
{%- else -%}
    {{- default_system_message -}}
{%- endif -%}

{%- if tools is defined and tools is not none and tools|length > 0 -%}
[AVAILABLE_TOOLS]{{ tools | tojson }}[/AVAILABLE_TOOLS]
{%- endif -%}

{%- set ns = namespace(index=0) -%}
{%- for message in (messages[0].role == 'system' and messages[1:] or messages) -%}
    {%- if message.role == 'user' or (message.role == 'assistant' and (message.tool_calls is not defined or message.tool_calls is none or message.tool_calls | length == 0)) -%}
        {%- if (message.role == 'user') != (ns.index % 2 == 0) -%}
            {{- raise_exception('After the optional system message, conversation roles must alternate user and assistant roles except for tool calls and results.') -}}
        {%- endif -%}
        {%- set ns.index = ns.index + 1 -%}
    {%- endif -%}
{%- endfor -%}

{%- for message in (messages[0].role == 'system' and messages[1:] or messages) -%}
    {%- if message.role == 'user' -%}
### User:
        {%- if message.content is string -%}
{{- message.content -}}
        {%- elif message.content | length > 0 -%}
            {%- if message.content | length == 2 and message.content[0].type == 'text' and message.content[1].type in ['image', 'image_url'] -%}
                {%- set blocks = [message.content[1], message.content[0]] -%}
            {%- else -%}
                {%- set blocks = message.content -%}
            {%- endif -%}
            {%- for block in blocks -%}
                {%- if block.type == 'text' -%}
{{- block.text -}}
                {%- elif block.type in ['image', 'image_url'] -%}
[IMG]
                {%- else -%}
                    {{- raise_exception('Only text, image and image_url chunks are supported in user message content.') -}}
                {%- endif -%}
            {%- endfor -%}
        {%- else -%}
            {{- raise_exception('User message must have a string or a list of chunks in content') -}}
        {%- endif -%}

    {%- elif message.role == 'assistant' -%}
### Assistant:
        {%- if (message.content is none or message.content == '' or message.content|length == 0) and (message.tool_calls is not defined or message.tool_calls is none or message.tool_calls|length == 0) -%}
            {{- raise_exception('Assistant message must have a string or a list of chunks in content or a list of tool calls.') -}}
        {%- endif -%}

        {%- if message.content is string and message.content != '' -%}
{{- message.content -}}
        {%- elif message.content | length > 0 -%}
            {%- for block in message.content -%}
                {%- if block.type == 'text' -%}
{{- block.text -}}
                {%- elif block.type == 'thinking' -%}
[THINK]{{- block.thinking -}}[/THINK]
                {%- else -%}
                    {{- raise_exception('Only text and thinking chunks are supported in assistant message contents.') -}}
                {%- endif -%}
            {%- endfor -%}
        {%- endif -%}

        {%- if message.tool_calls is defined and message.tool_calls is not none and message.tool_calls|length > 0 -%}
            {%- for tool in message.tool_calls -%}
[TOOL_CALLS]{{- tool.function.name -}}[ARGS]{{- tool.function.arguments is string and tool.function.arguments or tool.function.arguments | tojson -}}
            {%- endfor -%}
        {%- endif -%}

{{- eos_token -}}

    {%- elif message.role == 'tool' -%}
[TOOL_RESULTS]{{- message.content | string -}}[/TOOL_RESULTS]
    {%- else -%}
        {{- raise_exception('Only user, assistant and tool roles are supported, got ' + message.role + '.') -}}
    {%- endif -%}
{%- endfor -%}
```

> Use this template when you need a fully OpenAI-compatible prompt format for chat history and optional tools.
