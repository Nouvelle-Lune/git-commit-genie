import React, { useState } from 'react';
import './ThemeColor.css';

interface ThemeColorProps {
    onColorSelected: (color: string) => void;
}

const colors = ['#007acc', '#68217a', '#0e7c86', '#dd5144'];

export const ThemeColor: React.FC<ThemeColorProps> = ({ onColorSelected }) => {
    const [selectedColor, setSelectedColor] = useState<string | null>(null);

    const handleColorClick = (color: string) => {
        setSelectedColor(color);
        onColorSelected(color);
    };

    return (
        <div className="section">
            <h3>Theme Color</h3>
            <div className="color-picker">
                {colors.map((color) => (
                    <button
                        key={color}
                        className={`color-btn ${selectedColor === color ? 'selected' : ''}`}
                        style={{ background: color }}
                        onClick={() => handleColorClick(color)}
                        aria-label={`Select color ${color}`}
                    />
                ))}
            </div>
        </div>
    );
};
