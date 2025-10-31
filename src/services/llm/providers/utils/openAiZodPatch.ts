import { z } from "zod";
import { makeParseableResponseFormat, makeParseableTextFormat } from 'openai/lib/parser';

import type { AutoParseableResponseFormat, AutoParseableTextFormat } from 'openai/lib/parser';
import type { ResponseFormatJSONSchema } from 'openai/resources';
import type { ResponseFormatTextJSONSchemaConfig } from 'openai/resources/responses/responses';

type TextFormatOptions = Omit<ResponseFormatTextJSONSchemaConfig, 'schema' | 'type' | 'name'> & {
    strict?: boolean;
};

type JsonSchemaOptions = Omit<ResponseFormatJSONSchema.JSONSchema, 'schema' | 'name'> & {
    strict?: boolean;
};

export function zodResponseFormat<ZodInput extends z.ZodType>(
    zodObject: ZodInput,
    name: string,
    props?: JsonSchemaOptions,
): AutoParseableResponseFormat<z.infer<ZodInput>> {
    const strict = props?.strict ?? true;
    const { strict: _omitStrict, ...rest } = props || {};
    return makeParseableResponseFormat(
        {
            type: 'json_schema',
            json_schema: {
                ...rest,
                name,
                strict,
                schema: z.toJSONSchema(zodObject, { target: 'draft-7' }),
            },
        },
        (content) => zodObject.parse(JSON.parse(content)),
    );
}

export function zodTextFormat<ZodInput extends z.ZodType>(
    zodObject: ZodInput,
    name: string,
    props?: TextFormatOptions,
): AutoParseableTextFormat<z.infer<ZodInput>> {
    const strict = props?.strict ?? true;
    const { strict: _omitStrict, ...rest } = props || {};
    return makeParseableTextFormat(
        {
            type: 'json_schema',
            ...rest,
            name,
            strict,
            schema: z.toJSONSchema(zodObject, { target: 'draft-7' }),
        },
        (content) => zodObject.parse(JSON.parse(content)),
    );
}